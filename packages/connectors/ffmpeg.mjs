import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { payloadDigest } from '../local/authority.mjs';
import { requireValue } from '../local/store.mjs';

// The optional owner image is passed as bounded PNG bytes over stdin. The
// renderer accepts neither user filter expressions nor input URLs.
export function ffmpegRenderer({ binary = 'ffmpeg', png } = {}) {
  const version = spawnSync(binary, ['-version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  const build = version.stdout?.match(
    /^ffmpeg version ([A-Za-z0-9.+_-]+)/
  )?.[1];
  requireValue(version.status === 0 && build, 'FFmpeg executable unavailable');
  let source = null;
  if (png) {
    requireValue(
      fs.statSync(png).isFile() && fs.statSync(png).size <= 16 * 1024 * 1024,
      'Source PNG exceeds intake budget'
    );
    source = fs.readFileSync(png);
    requireValue(
      source.length >= 33 &&
        source.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
        source.toString('ascii', 12, 16) === 'IHDR' &&
        source.readUInt32BE(16) > 0 &&
        source.readUInt32BE(20) > 0 &&
        source.readUInt32BE(16) * source.readUInt32BE(20) <= 16000000,
      'Invalid or oversized source PNG'
    );
  }
  const sourceDigest = source ? payloadDigest(source) : null;
  return {
    id: 'ffmpeg/' + build.replace(/[^a-zA-Z0-9._-]/g, '-'),
    sourceDigest,
    start(spec, { signal }) {
      signal.throwIfAborted();
      requireValue(
        spec.sourceDigest === sourceDigest,
        'Media source changed since proposal'
      );
      const size = spec.width + 'x' + spec.height;
      const input = source
        ? [
            '-protocol_whitelist',
            'pipe',
            '-f',
            'image2pipe',
            '-c:v',
            'png',
            '-i',
            'pipe:0'
          ]
        : ['-f', 'lavfi', '-i', 'testsrc2=s=' + size + ':r=12'];
      const filter =
        'scale=' +
        spec.width +
        ':' +
        spec.height +
        ':force_original_aspect_ratio=decrease,pad=' +
        spec.width +
        ':' +
        spec.height +
        ':(ow-iw)/2:(oh-ih)/2,setsar=1';
      const output =
        spec.kind === 'image'
          ? ['-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe']
          : [
              '-t',
              String(spec.seconds),
              '-r',
              '12',
              '-pix_fmt',
              'yuv420p',
              '-c:v',
              'libx264',
              '-preset',
              'veryfast',
              '-movflags',
              'frag_keyframe+empty_moov',
              '-f',
              'mp4'
            ];
      const child = spawn(
        binary,
        [
          '-v',
          'error',
          '-nostdin',
          ...input,
          '-an',
          '-vf',
          filter +
            (source && spec.kind === 'video'
              ? ',tpad=stop_mode=clone:stop_duration=' + spec.seconds
              : ''),
          '-threads',
          '1',
          ...output,
          'pipe:1'
        ],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }
      );
      child.stdin.on('error', () => {});
      child.stdin.end(source);
      const done = new Promise((resolve, reject) => {
        child.once('error', () => reject(Error('FFmpeg could not start')));
        child.once('close', (code) =>
          code === 0
            ? resolve()
            : reject(Error('FFmpeg did not complete the artifact'))
        );
      });
      return { output: child.stdout, done, stop: () => child.kill('SIGKILL') };
    }
  };
}
