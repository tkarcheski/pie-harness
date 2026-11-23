import fs from 'node:fs/promises';
import { MediaDesk } from '../../packages/connectors/media.mjs';
import { ffmpegRenderer } from '../../packages/connectors/ffmpeg.mjs';

const [cmd, directory, arg, png] = process.argv.slice(2);
let desk;
try {
  if (!directory || !['render', 'status', 'recover', 'cancel'].includes(cmd))
    throw Error(
      'Use render DIRECTORY SPEC.json [source.png], status/cancel DIRECTORY KEY, or recover DIRECTORY'
    );
  desk = new MediaDesk(directory);
  let result;
  if (cmd === 'render') {
    const spec = JSON.parse(await fs.readFile(arg, 'utf8')),
      control = new AbortController();
    const renderer = ffmpegRenderer({
      binary: process.env.PIE_FFMPEG_BIN || 'ffmpeg',
      png
    });
    const stop = () => control.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      result = await desk.render(
        { ...spec, sourceDigest: renderer.sourceDigest },
        renderer,
        { signal: control.signal }
      );
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } else if (cmd === 'recover') result = desk.recover();
  else result = cmd === 'cancel' ? desk.cancel(arg) : desk.status(arg);
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  desk?.close();
}
