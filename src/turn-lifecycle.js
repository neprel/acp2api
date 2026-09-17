/** Owns timeout, disconnect and guaranteed release for every HTTP-backed turn. */
export async function runTurnLifecycle({ req, res, config, run, failed, release }) {
  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  let abortPendingTurn = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    abortPendingTurn?.();
  }, config.server.requestTimeoutMs);
  const disconnected = () => {
    if (res.writableEnded) return;
    clientGone = true;
    controller.abort();
  };
  // IncomingMessage `close` also describes an ordinary fully-read request on
  // modern Node. ServerResponse `close` is the reliable signal that the response
  // socket vanished before `end`; `aborted` covers a body upload cut short.
  req.once("aborted", disconnected);
  res.once("close", disconnected);
  const turn = {
    controller,
    clientGone: () => clientGone,
    timedOut: () => timedOut,
    abortPendingWith: (abort) => { abortPendingTurn = abort; },
  };
  try {
    return await run(turn);
  } catch (error) {
    return await failed(error, turn);
  } finally {
    clearTimeout(timer);
    release();
  }
}
