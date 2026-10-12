const emotions = [
  ['开心','高兴','快乐','喜欢','太好了','哈哈','嘿嘿','好耶','笑'],
  ['难过','伤心','哭','委屈','失落','安慰','陪你','抱抱'],
  ['生气','愤怒','气死','不满'], ['感谢','谢谢','感激'],
  ['晚安','睡觉','困','休息'], ['疑惑','不懂','疑问','什么','为什么'],
  ['无语','尴尬','无奈'], ['你好','早安','问候','欢迎'],
  ['可爱','摸头','摸摸','投喂','亲昵']
];
export function matchSticker(entries, text, lastId = '') {
  const context = String(text || '').toLowerCase();
  const ranked = entries.filter(e => e.url && e.id !== lastId).map(entry => {
    const labels = [...(entry.tags || []), entry.localNote, entry.usage, entry.desc].filter(Boolean);
    const metadata = labels.join(' ').toLowerCase();
    let score = 0;
    for (const group of emotions) {
      if (group.some(w => context.includes(w)) && group.some(w => metadata.includes(w))) score += 3;
    }
    for (const label of labels) {
      for (const word of String(label).toLowerCase().split(/[\s,，、;；/]+/)) {
        if (word.length >= 2 && context.includes(word)) score += 2;
      }
    }
    return {entry, score};
  }).filter(x => x.score > 0).sort((a,b) => b.score-a.score || (a.entry.lastUsedAt||0)-(b.entry.lastUsedAt||0));
  return ranked[0]?.entry || null;
}
