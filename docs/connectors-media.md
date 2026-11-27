# Bounded image and video jobs

## Render an artifact

Install FFmpeg on `PATH`, or set `PIE_FFMPEG_BIN` to its executable. Choose a private output directory outside Git. Run `node apps/connectors/media.mjs render DIRECTORY SPEC.json [source.png]`.

Supply an original PNG or use the generated test pattern. The worker sends a supplied PNG to FFmpeg through standard input and binds its digest to the job. The output is a PNG image or an H.264 fragmented MP4.

Use this specification for a synthetic image test.

~~~json
{
  "key": "pattern-proof", "kind": "image", "width": 240, "height": 320,
  "sourceRef": "fixture:generated-pattern", "rightsRef": "fixture:generated",
  "maxBytes": 1048576, "jobMs": 60000, "stepMs": 10000
}
~~~

For a video, use a new key. Set `kind` to `video` and `seconds` to a value from 1 to 30. To make a still clip, supply the generated PNG as the source.

The job record contains the input and rights references, input digest, renderer build, format, dimensions, byte limit, timeout and original deadline. Set one to three attempts. Use a new key if the specification changes. When you repeat a completed job, the worker verifies its manifest and returns the original file reference.

## Check or cancel a running job

Open another local process. Run `node apps/connectors/media.mjs status DIRECTORY KEY` to inspect the lease and attempts. Run `node apps/connectors/media.mjs cancel DIRECTORY KEY` to stop the renderer.

The supervisor checks the byte limit and elapsed time while the renderer writes to a private staging directory. Cancellation removes partial output. After format checks, the worker publishes the complete file and provenance manifest together under the job ID.

## Recover after a process stops

Run `node apps/connectors/media.mjs recover DIRECTORY`. Recovery verifies published bundles and removes expired partial attempts. When the job is ready again, repeat the original render command. The job keeps its deadline and attempt count.

The regression test terminates a separate renderer during a write. It verifies recovery from the same SQLite database. [Media supervisor](../packages/connectors/media.mjs) · [FFmpeg renderer](../packages/connectors/ffmpeg.mjs)
