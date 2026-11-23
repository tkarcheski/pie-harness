import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store, requireValue } from '../local/store.mjs';
import { payloadDigest } from '../local/authority.mjs';

const identifier = (s) =>
  typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,191}$/.test(s);
const integer = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const leaf = (kind) => (kind === 'image' ? 'image.png' : 'video.mp4');
function specification(input, renderer) {
  const {
    key,
    kind,
    sourceRef,
    rightsRef,
    sourceDigest = null,
    width,
    height,
    seconds = 1,
    maxBytes,
    jobMs,
    stepMs,
    maxAttempts = 2
  } = input;
  requireValue(
    [key, sourceRef, rightsRef, renderer].every(identifier) &&
      ['image', 'video'].includes(kind),
    'Identify the job, source, rights and renderer'
  );
  requireValue(
    sourceDigest === null || /^[a-f0-9]{64}$/.test(sourceDigest),
    'Invalid input SHA-256'
  );
  requireValue(
    [width, height].every((v) => integer(v, 2, 1920) && v % 2 === 0) &&
      width * height <= 2073600,
    'Invalid output dimensions'
  );
  requireValue(
    integer(seconds, 1, 30) &&
      (kind !== 'image' || seconds === 1) &&
      integer(maxBytes, 1, 32 * 1024 * 1024) &&
      integer(jobMs, 1, 3600000) &&
      integer(stepMs, 1, Math.min(jobMs, 900000)) &&
      integer(maxAttempts, 1, 3),
    'Invalid media budget or deadline'
  );
  return {
    key,
    kind,
    sourceRef,
    rightsRef,
    sourceDigest,
    renderer,
    width,
    height,
    seconds,
    maxBytes,
    jobMs,
    stepMs,
    maxAttempts
  };
}

function privateDirectory(directory) {
  const resolved = path.resolve(directory);
  let prefix = resolved;
  while (!fs.existsSync(prefix)) prefix = path.dirname(prefix);
  const real = path.join(
    fs.realpathSync(prefix),
    path.relative(prefix, resolved)
  );
  for (let d = real; ; d = path.dirname(d)) {
    requireValue(
      !fs.existsSync(path.join(d, '.git')),
      'Use a media state directory outside Git'
    );
    if (path.dirname(d) === d) break;
  }
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
  return real;
}
function signature(bytes, kind) {
  return kind === 'image'
    ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : bytes.toString('ascii', 4, 8) === 'ftyp';
}
function completeFile(bytes, spec) {
  if (!signature(bytes, spec.kind)) return false;
  if (spec.kind === 'image')
    return (
      bytes.length >= 45 &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) === spec.width &&
      bytes.readUInt32BE(20) === spec.height &&
      bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))
    );
  const boxes = new Set();
  for (let pos = 0; pos < bytes.length; ) {
    if (bytes.length - pos < 8) return false;
    const size = bytes.readUInt32BE(pos),
      type = bytes.toString('ascii', pos + 4, pos + 8);
    if (size < 8 || size > bytes.length - pos) return false;
    if (size > 8) boxes.add(type);
    pos += size;
  }
  return boxes.has('moov') && boxes.has('mdat');
}

export class MediaDesk {
  constructor(directory, { clock = Date.now } = {}) {
    this.root = privateDirectory(directory);
    this.store = new Store(path.join(this.root, 'media.sqlite'), clock);
  }
  close() {
    this.store.close();
  }
  status(key) {
    return this.store.read().mediaJobs?.find((j) => j.key === key) ?? null;
  }
  cancel(key) {
    return this.store.change((s) => {
      const job = s.mediaJobs?.find((j) => j.key === key);
      requireValue(job, 'Unknown media job');
      if (!['done', 'failed', 'cancelled'].includes(job.state))
        job.state = 'cancelled';
      return job;
    });
  }
  // Rename and SQLite commit do not form a filesystem transaction. Reconcile
  // a published bundle against the original job and content digest on restart.
  #published(job) {
    const folder = path.join(this.root, job.id);
    if (!fs.existsSync(folder)) return null;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(folder, 'artifact.json'), 'utf8')
    );
    const file = path.join(folder, leaf(job.spec.kind)),
      size = fs.statSync(file).size;
    requireValue(
      manifest.job === job.id &&
        manifest.fingerprint === job.fingerprint &&
        size > 0 &&
        size === manifest.bytes &&
        size <= job.spec.maxBytes &&
        manifest.kind === job.spec.kind &&
        manifest.file === leaf(job.spec.kind) &&
        manifest.sourceRef === job.spec.sourceRef &&
        manifest.rightsRef === job.spec.rightsRef &&
        manifest.sourceDigest === job.spec.sourceDigest &&
        manifest.renderer === job.spec.renderer &&
        (!job.artifact || job.artifact.sha256 === manifest.sha256),
      'Published media manifest mismatch'
    );
    const bytes = fs.readFileSync(file);
    requireValue(
      completeFile(bytes, job.spec) && payloadDigest(bytes) === manifest.sha256,
      'Published media integrity check failed'
    );
    return manifest;
  }
  #recover(job, now) {
    const manifest = this.#published(job);
    if (manifest) {
      job.state = 'done';
      job.artifact = manifest;
      delete job.attempt;
      return;
    }
    requireValue(job.state !== 'done', 'Published media is missing');
    if (job.attempt && now >= job.attempt.until) {
      fs.rmSync(path.join(this.root, '.stage-' + job.attempt.id), {
        recursive: true,
        force: true
      });
      delete job.attempt;
      if (job.state !== 'cancelled')
        job.state =
          now >= job.deadline || job.attempts >= job.spec.maxAttempts
            ? 'failed'
            : 'ready';
    }
  }
  recover() {
    return this.store.change((s, now) =>
      (s.mediaJobs ?? []).map((j) => {
        this.#recover(j, now);
        return { key: j.key, state: j.state };
      })
    );
  }
  async render(input, renderer, { signal } = {}) {
    signal?.throwIfAborted();
    const spec = specification(input, renderer.id),
      fingerprint = payloadDigest(JSON.stringify(spec));
    const claim = this.store.change((s, now) => {
      const jobs = (s.mediaJobs ??= []);
      let job = jobs.find((j) => j.key === spec.key);
      if (job) {
        requireValue(
          job.fingerprint === fingerprint,
          'Conflicting media job key'
        );
        this.#recover(job, now);
      } else {
        job = {
          id: randomUUID(),
          key: spec.key,
          fingerprint,
          spec,
          state: 'ready',
          attempts: 0,
          deadline: now + spec.jobMs
        };
        jobs.push(job);
      }
      if (job.state === 'done') return { job };
      requireValue(
        job.state === 'ready' &&
          now < job.deadline &&
          job.attempts < spec.maxAttempts,
        'Media job unavailable or budget exhausted'
      );
      const attempt = {
        id: randomUUID(),
        until: Math.min(job.deadline, now + spec.stepMs)
      };
      job.attempt = attempt;
      job.attempts++;
      job.state = 'running';
      const staging = path.join(this.root, '.stage-' + attempt.id);
      return { job, attempt, staging };
    });
    if (!claim.attempt) return claim.job.artifact;
    const { job, attempt, staging } = claim;
    const control = new AbortController();
    const expiry = AbortSignal.timeout(
      Math.max(1, attempt.until - this.store.clock())
    );
    const active = AbortSignal.any([
      expiry,
      control.signal,
      ...(signal ? [signal] : [])
    ]);
    let rendered, guard;
    const cancel = () => {
      rendered?.stop();
    };
    const observe = () => {
      try {
        const current = this.status(job.key);
        if (current?.state !== 'running' || current?.attempt?.id !== attempt.id)
          control.abort();
      } catch {
        control.abort();
      }
    };
    try {
      fs.mkdirSync(staging, { mode: 0o700 });
      guard = setInterval(observe, 100);
      active.throwIfAborted();
      rendered = renderer.start(spec, { signal: active });
      active.addEventListener('abort', cancel, { once: true });
      const hash = createHash('sha256');
      let bytes = 0,
        header = Buffer.alloc(0);
      const count = new Transform({
        transform(chunk, _encoding, cb) {
          bytes += chunk.length;
          if (bytes > spec.maxBytes)
            return cb(Error('Media byte budget exceeded'));
          if (header.length < 12)
            header = Buffer.concat([
              header,
              chunk.subarray(0, 12 - header.length)
            ]);
          hash.update(chunk);
          cb(null, chunk);
        }
      });
      const copy = pipeline(
        rendered.output,
        count,
        fs.createWriteStream(path.join(staging, leaf(spec.kind)), {
          flags: 'wx',
          mode: 0o600
        }),
        { signal: active }
      );
      let rejectStop;
      const stopped = new Promise((_, rej) => {
        rejectStop = () => rej(Error('Media rendering interrupted'));
        active.addEventListener('abort', rejectStop, { once: true });
      });
      try {
        await Promise.race([Promise.all([copy, rendered.done]), stopped]);
      } catch (error) {
        control.abort();
        await copy.catch(() => {});
        throw error;
      } finally {
        active.removeEventListener('abort', rejectStop);
      }
      requireValue(
        bytes && signature(header, spec.kind),
        'Renderer produced an invalid media file'
      );
      requireValue(
        completeFile(
          fs.readFileSync(path.join(staging, leaf(spec.kind))),
          spec
        ),
        'Incomplete media or unexpected dimensions'
      );
      const artifact = {
        job: job.id,
        fingerprint,
        kind: spec.kind,
        file: leaf(spec.kind),
        renderer: spec.renderer,
        sourceRef: spec.sourceRef,
        sourceDigest: spec.sourceDigest,
        rightsRef: spec.rightsRef,
        bytes,
        sha256: hash.digest('hex')
      };
      fs.writeFileSync(
        path.join(staging, 'artifact.json'),
        JSON.stringify(artifact, null, 2),
        { flag: 'wx', mode: 0o600 }
      );
      return this.store.change((s, now) => {
        const current = s.mediaJobs.find((j) => j.id === job.id);
        requireValue(
          current.state === 'running' &&
            current.attempt?.id === attempt.id &&
            now < attempt.until &&
            !active.aborted,
          'Media lease expired before publication'
        );
        fs.renameSync(staging, path.join(this.root, job.id));
        current.state = 'done';
        current.artifact = artifact;
        delete current.attempt;
        return artifact;
      });
    } catch (error) {
      control.abort();
      fs.rmSync(staging, { recursive: true, force: true });
      this.store.change((s, now) => {
        const j = s.mediaJobs.find((j) => j.id === job.id);
        if (j.attempt?.id !== attempt.id) return;
        if (this.#published(j)) {
          this.#recover(j, now);
          return;
        }
        if (j.state !== 'cancelled')
          j.state = signal?.aborted
            ? 'cancelled'
            : now >= j.deadline || j.attempts >= spec.maxAttempts
              ? 'failed'
              : 'ready';
        delete j.attempt;
      });
      throw error;
    } finally {
      clearInterval(guard);
      active.removeEventListener('abort', cancel);
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}
