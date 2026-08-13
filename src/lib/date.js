const NEW_BADGE_HOURS = 24;

export function fmtTime(d) {
  return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function isNewPost(pubDate) {
  return Date.now() - pubDate.valueOf() < NEW_BADGE_HOURS * 60 * 60 * 1000;
}
