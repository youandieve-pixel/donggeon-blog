const NEW_BADGE_HOURS = 24;
export const KST_TIME_ZONE = 'Asia/Seoul';

// 빌드 서버에 ko 로케일 전체 ICU 데이터가 없을 수 있어 오전/오후는 직접 만든다.
// 시/분은 en-US + Asia/Seoul 타임존으로 뽑아내 서버 타임존과 무관하게 KST 기준으로 고정한다.
export function fmtTime(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KST_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(d);
  const hour24 = Number(parts.find((p) => p.type === 'hour').value);
  const minute = parts.find((p) => p.type === 'minute').value;
  const period = hour24 < 12 ? '오전' : '오후';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${period} ${hour12}:${minute}`;
}

export function isNewPost(pubDate) {
  return Date.now() - pubDate.valueOf() < NEW_BADGE_HOURS * 60 * 60 * 1000;
}
