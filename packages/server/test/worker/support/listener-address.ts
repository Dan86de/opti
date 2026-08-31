/**
 * Where the egress test's listener lives.
 *
 * Its own module because the listener itself runs in node and this constant is
 * read from inside workerd - importing the listener from a worker test would
 * drag `node:net` into the sandbox bundle.
 *
 * The port is fixed rather than ephemeral so that nothing has to be passed
 * across the node/workerd boundary to reach it. If it is ever taken, the
 * listener fails to start and says so, which is a loud failure rather than a
 * test that quietly proves nothing.
 */
export const LISTENER_HOST = "127.0.0.1";
export const LISTENER_PORT = 43199;
export const LISTENER_ORIGIN = `http://${LISTENER_HOST}:${LISTENER_PORT}`;
