export const CAPACITY = 10;
export const RECONNECT_MS = 30_000;
export const ROOM_IDS = Object.freeze(['dream-a', 'dream-b']);
export const BALL_COUNT = 4;

export function isRoomId(value) {
  return ROOM_IDS.includes(value);
}

export function allowedModes(room) {
  return isRoomId(room) ? ['sleep', 'float'] : [];
}

export function defaultMode(room) {
  return isRoomId(room) ? 'sleep' : undefined;
}

export function nextSeat(members) {
  const used = new Set(Array.from(members.values(), member => member.seat));
  for (let seat = 0; seat < CAPACITY; seat++) {
    if (!used.has(seat)) return seat;
  }
  return -1;
}

export function canAdmit(members, token) {
  return members.has(token) || members.size < CAPACITY;
}

export function publicMember(member) {
  return {
    id: member.id,
    ball: member.ball,
    seat: member.seat,
    mode: member.mode,
    reconnecting: member.until !== null
  };
}

export function expiredTokens(members, now) {
  return [...members].filter(([, m]) => m.until !== null && m.until <= now).map(([token]) => token);
}
