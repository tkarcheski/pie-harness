# Bounded image and video jobs

Run `node apps/connectors/media.mjs render DIRECTORY SPEC.json [source.png]` with FFmpeg on PATH, or set `PIE_FFMPEG_BIN` to its executable. Choose a private directory outside Git. The renderer accepts an original PNG or generates a test pattern. It produces a PNG image or H.264 fragmented MP4. The optional source PNG travels to FFmpeg over stdin and its digest is bound to the job.

Example image specification for a synthetic rehearsal:

~~~json
{
  "key": "pattern-proof", "kind": "image", "width": 240, "height": 320,
  "sourceRef": "fixture:generated-pattern", "rightsRef": "fixture:generated",
  "maxBytes": 1048576, "jobMs": 60000, "stepMs": 10000
}
~~~

For a video use a new key, set `kind` to `video` and supply `seconds` from 1 through 30. Reuse the generated PNG as source to render a still clip. Each job records the input reference, rights reference, input digest, renderer build, format, dimensions, byte cap, timeout and original deadline. It accepts one to three attempts. Changing the specification requires a new key. A successfully completed retry checks the manifest and returns the original file reference.

From another local process, run `node apps/connectors/media.mjs cancel DIRECTORY KEY` to request cancellation, or `status DIRECTORY KEY` to inspect the current lease and attempts. Output streams into a private staging directory while the supervisor enforces the byte cap and elapsed deadline. On cancellation, the renderer terminates and partial output is removed. The completed file and its provenance manifest publish together under the job ID after format checks.

After an unclean exit, `node apps/connectors/media.mjs recover DIRECTORY` verifies already published bundles and removes expired partial attempts. A resumable job retains its original deadline and attempt count. Rerun its identical render command when its state is ready. The regression suite kills a separate rendering process mid-write and verifies recovery using the same SQLite database. [Media supervisor](../packages/connectors/media.mjs) · [FFmpeg renderer](../packages/connectors/ffmpeg.mjs)
