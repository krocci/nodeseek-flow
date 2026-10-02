// Minimal MAIN-world editor adapter. It never receives credentials or network commands.
(() => {
  window.addEventListener('nsflow:menus', ((event: CustomEvent) => {
    const items = event.detail;
    const comments = (window as any).__config__?.postData?.comments;
    if (!Array.isArray(items) || items.length > 1000 || !Array.isArray(comments)) return;
    const template = [...document.querySelectorAll('.comment-menu')]
      .map((n) => (n as any).__vue__)
      .find((v) => typeof v?.setIndex === 'function' && typeof v?.$mount === 'function');
    if (!template) return;
    for (const item of items) {
      if (!item || !/^\d+$/.test(item.id) || !Number.isInteger(item.floor)) continue;
      const node = document.querySelector<HTMLElement>(
        'ul.comments > [data-comment-id="' + item.id + '"]',
      );
      const mount = node?.querySelector('.nf-native-mount');
      if (!node || Number(node.id) !== item.floor) continue;
      let index = comments.findIndex(
        (c: any) => String(c.commentId) === item.id && Number(c.floorIndex) === item.floor,
      );
      if (
        item.refresh === true &&
        index >= 0 &&
        String(item.nativeComment?.commentId) === item.id &&
        Number(item.nativeComment?.floorIndex) === item.floor &&
        typeof item.nativeComment?.content === 'string'
      ) {
        comments[index].content = item.nativeComment.content;
      }
      if (!mount) continue;
      if (index < 0) {
        const c = item.nativeComment;
        if (!c || String(c.commentId) !== item.id || Number(c.floorIndex) !== item.floor) continue;
        comments.push(JSON.parse(JSON.stringify(c)));
        index = comments.length - 1;
      }
      // Resolve by comment ID, never by DOM order (hot comments reorder floors).
      try {
        const menu = new template.constructor({ ...template.$options, parent: template.$parent });
        menu.setIndex(index);
        menu.$mount();
        if (!menu.$el?.classList?.contains('comment-menu')) {
          menu.$destroy();
          continue;
        }
        mount.replaceWith(menu.$el);
        node.dataset.nfNative = 'ready';
      } catch {
        node.dataset.nfNative = 'unavailable';
      }
    }
  }) as EventListener);
  window.addEventListener('nsflow:editor', ((event: CustomEvent) => {
    const d = event.detail;
    if (
      !d ||
      typeof d.id !== 'string' ||
      d.id.length > 80 ||
      !['insert', 'focus'].includes(d.action) ||
      typeof d.text !== 'string' ||
      d.text.length > 20000
    )
      return;
    const wrapper = document.querySelector('.CodeMirror') as HTMLElement & {
      CodeMirror?: { focus: () => void; replaceSelection: (text: string) => void };
    };
    let ok = false;
    try {
      if (wrapper?.CodeMirror) {
        wrapper.CodeMirror.focus();
        if (d.action === 'insert') wrapper.CodeMirror.replaceSelection(d.text);
        ok = true;
      } else {
        const t = document.querySelector('#editor textarea,textarea') as HTMLTextAreaElement | null;
        if (t) {
          t.focus();
          if (d.action === 'insert') {
            t.setRangeText(d.text, t.selectionStart, t.selectionEnd, 'end');
            t.dispatchEvent(new Event('input', { bubbles: true }));
          }
          ok = true;
        }
      }
    } catch {}
    window.dispatchEvent(new CustomEvent('nsflow:editor-result', { detail: { id: d.id, ok } }));
  }) as EventListener);
})();
