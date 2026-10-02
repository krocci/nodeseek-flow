window.chrome = {
  runtime: {
    id: 'preview',
    getURL: (p) => '/' + p,
    onMessage: { addListener: () => {} },
    sendMessage: async (m) => {
      const res = await fetch('/mock-rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(m),
      });
      return res.json();
    },
  },
  permissions: { request: async () => true },
};
const realFetch = window.fetch.bind(window);
window.fetch = (input, opts) => {
  let u = String(input);
  if (u.startsWith('https://www.nodeseek.com/')) u = u.replace('https://www.nodeseek.com', '');
  return realFetch(u, opts);
};
