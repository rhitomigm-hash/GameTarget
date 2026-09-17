// 静的公開・ローカル配信・ファイル直開きで、同じSORAへの入口を使う。
(() => {
  const local = location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const base = local ? 'http://localhost:8002/prototype/' : 'https://rhitomigm-hash.github.io/SORA/prototype/';
  for (const link of document.querySelectorAll('[data-sora-link]')) {
    const url = new URL(link.dataset.soraLink === 'home' ? '../' : './', base);
    url.search = link.dataset.soraQuery || '';
    link.href = url.href;
  }
})();
