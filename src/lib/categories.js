export const CATEGORIES = [
  { id: 'real-estate', label: '부동산', color: '#a8462f' },
  { id: 'stocks', label: '증시', color: '#2f6b45' },
  { id: 'economy', label: '경제·정책', color: '#1c2b45' },
  { id: 'tips', label: '재테크 팁', color: '#a9790a' }
];

export function categoryLabel(id) {
  const found = CATEGORIES.find((c) => c.id === id);
  return found ? found.label : id;
}

export function categoryColor(id) {
  const found = CATEGORIES.find((c) => c.id === id);
  return found ? found.color : '#a9790a';
}
