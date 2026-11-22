const maxTurnMs = 15 * 60 * 1000;

function localModel(model) {
  if (
    typeof model !== 'string' ||
    !model.trim() ||
    model.length > 200 ||
    /(?:^|[:-])cloud(?:$|[-:])/i.test(model)
  )
    throw Error('Choose an installed local model');
}

// The provider owns model metadata and inference transport. Callers can inspect
// capabilities without creating a session, loading weights or generating text.
export class OllamaProvider {
  #origin;

  constructor({ origin = 'http://127.0.0.1:11434' } = {}) {
    const url = new URL(origin);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw Error(
        'Use an HTTP loopback IP and port for the local Ollama provider'
      );
    this.#origin = url.origin;
  }

  async #post(endpoint, body, signal) {
    signal.throwIfAborted();
    let response;
    try {
      response = await fetch(this.#origin + '/api/' + endpoint, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (error) {
      signal.throwIfAborted();
      throw Error(
        'Local Ollama ' +
          endpoint +
          ' request failed at ' +
          this.#origin +
          '. Check the local service.',
        { cause: error }
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('Local Ollama ' + endpoint + ' returned ' + response.status);
    }
    try {
      return await response.json();
    } catch (error) {
      signal.throwIfAborted();
      throw Error('Local Ollama ' + endpoint + ' returned invalid JSON', {
        cause: error
      });
    }
  }

  async describe(model, { signal } = {}) {
    localModel(model);
    const timeout = AbortSignal.timeout(10000);
    const info = await this.#post(
      'show',
      { model },
      signal ? AbortSignal.any([signal, timeout]) : timeout
    );
    if (
      info?.remote_model ||
      info?.remote_host ||
      typeof info?.details?.format !== 'string' ||
      !info.details.format.trim()
    )
      throw Error('Choose an installed local model');
    // Older Ollama versions omit capabilities. Keep this distinction visible
    // and let the existing local chat path establish actual support on use.
    const features = info.capabilities ?? null;
    if (
      features !== null &&
      !(Array.isArray(features) && features.every((x) => typeof x === 'string'))
    )
      throw Error('Local Ollama returned invalid model capabilities');
    return {
      model,
      format: info.details.format,
      capabilities: features && [...new Set(features)]
    };
  }

  async complete({ model, messages, format, temperature, signal }) {
    const limit = AbortSignal.timeout(maxTurnMs);
    const active = signal ? AbortSignal.any([signal, limit]) : limit;
    const profile = await this.describe(model, { signal: active });
    if (
      profile.capabilities !== null &&
      !profile.capabilities.includes('completion')
    )
      throw Error('The selected local model does not support text completion');
    const reply = await this.#post(
      'chat',
      {
        model,
        messages,
        format,
        stream: false,
        options: temperature === undefined ? undefined : { temperature }
      },
      active
    );
    if (reply?.done !== true || typeof reply.message?.content !== 'string')
      throw Error('Local Ollama returned an incomplete chat response');
    return reply.message.content;
  }
}

// A runtime receives a provider exposing complete(request). It owns a fresh,
// cancellable turn; domain prompts, draft validation and tools stay with callers.
export class SingleTurnRuntime {
  constructor(provider, { timeoutMs = maxTurnMs } = {}) {
    if (typeof provider?.complete !== 'function')
      throw Error('A model provider is required');
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > maxTurnMs
    )
      throw Error('Agent timeout must be between 1 ms and 15 minutes');
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }

  async run({ model, messages, format, temperature, signal }) {
    signal?.throwIfAborted();
    const deadline = new AbortController();
    const active = signal
      ? AbortSignal.any([signal, deadline.signal])
      : deadline.signal;
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(active.reason);
      active.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException('Agent turn timed out', 'TimeoutError')
        ),
      this.timeoutMs
    );
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          active.throwIfAborted();
          return this.provider.complete({
            model,
            messages,
            format,
            temperature,
            signal: active
          });
        }),
        interrupted
      ]);
    } finally {
      clearTimeout(timer);
      active.removeEventListener('abort', onAbort);
    }
  }
}
