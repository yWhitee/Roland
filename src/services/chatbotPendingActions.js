const crypto = require('node:crypto');

const TTL = 5 * 60_000;
const RETAIN = 30 * 60_000;

const actions = new Map();

const prune = (now) => {
  for (const [id, action] of actions) {
    if (now - action.createdAt <= RETAIN) continue;
    clearTimeout(action.timer);
    actions.delete(id);
  }
};

const transition = (action, status) => {
  if (action.status !== 'pending') return false;
  clearTimeout(action.timer);
  action.status = status;
  return true;
};

const create = ({ guildId, channelId, ownerId, actorId, calls, state, onExpire, now = Date.now() }) => {
  prune(now);
  const action = { id: crypto.randomBytes(12).toString('hex'), guildId, channelId, ownerId, actorId, calls, state, createdAt: now, expiresAt: now + TTL, status: 'pending', message: null };
  action.timer = setTimeout(() => {
    if (transition(action, 'expired')) onExpire?.(action);
  }, TTL);
  action.timer.unref?.();
  actions.set(action.id, action);
  return action;
};

const get = (id, now = Date.now()) => {
  const action = actions.get(id) ?? null;
  if (action?.status === 'pending' && now >= action.expiresAt) transition(action, 'expired');
  return action;
};

const close = (matches, status) => [...actions.values()].filter((action) => action.status === 'pending' && matches(action) && transition(action, status));

const size = () => actions.size;

const clear = () => {
  for (const action of actions.values()) clearTimeout(action.timer);
  actions.clear();
};

module.exports = { TTL, create, get, transition, close, size, clear };
