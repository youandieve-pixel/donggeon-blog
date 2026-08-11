export const CATEGORIES = [
  { id: 'real-estate', label: '부동산' },
  { id: 'stocks', label: '증시' },
  { id: 'economy', label: '경제·정책' },
  { id: 'tips', label: '재테크 팁' }
];

export function categoryLabel(id) {
  const found = CATEGORIES.find((c) => c.id === id);
  return found ? found.label : id;
}
