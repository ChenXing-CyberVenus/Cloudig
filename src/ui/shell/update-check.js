export const releasePage = 'https://github.com/ChenXing-CyberVenus/Cloudig/releases';
let active = null;

/** One themed dialog; startup discovery only offers it, never starts a download. */
export function openUpdateCheck({ host, background, language, check, prepare, install, initial }) {
  if (active) { active.focus(); return active; }
  const en = language === 'en';
  const messages = en ? {
    checking: 'Checking the latest official release…', available: 'A new official version is available.',
    current: 'You are using the latest official version.', ahead: 'Your version is newer than the latest official release.',
    no_release: 'Cloudig has not published an official release yet.',
    unavailable: 'Could not reach GitHub. Check your connection and try again, or open the releases page.',
    timeout: 'The update check timed out. You can try again or open the releases page.',
    rate_limited: 'GitHub temporarily limited update requests. Please try again later.',
    invalid_response: 'GitHub returned unrecognized release information. Please check the releases page.',
    invalid_version: 'The version number could not be compared. Please check the releases page.'
  } : {
    checking: '正在查询最新正式版本…', available: '发现新的正式版本。',
    current: '当前已是最新正式版本。', ahead: '当前程序版本高于最新已发布正式版本。',
    no_release: '采云尚未发布正式版本。',
    unavailable: '暂时无法连接 GitHub，请检查网络后重试，也可以打开发布页查看。',
    timeout: '检查更新超时，请稍后重试，也可以打开发布页查看。',
    rate_limited: 'GitHub 暂时限制了查询频率，请稍后重试。',
    invalid_response: '收到的发布信息无法识别，请到发布页查看。',
    invalid_version: '暂时无法比较版本号，请到发布页查看。'
  };
  const previousFocus = document.activeElement, previousInert = background.inert;
  const layer = document.createElement('div'); layer.className = 'cloudig-dialog-layer';
  const dialog = document.createElement('section'); dialog.className = 'cloudig-dialog cloudig-update-dialog';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'cloudig-update-title');
  const title = document.createElement('h2'); title.id = 'cloudig-update-title'; title.textContent = en ? 'Check for Updates' : '检查更新';
  const message = document.createElement('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const facts = document.createElement('dl');
  const footer = document.createElement('footer');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'cloudig-button cloudig-button-outline'; retry.textContent = en ? 'Check Again' : '重新检查'; retry.dataset.updateRetry = '';
  const releases = document.createElement('a'); releases.className = 'cloudig-button cloudig-button-filled'; releases.href = releasePage; releases.target = '_blank'; releases.rel = 'noopener noreferrer'; releases.dataset.updateRelease = '';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'cloudig-button cloudig-button-outline'; close.textContent = en ? 'Close' : '关闭'; close.dataset.updateClose = '';
  const update = document.createElement('button'); update.type = 'button'; update.className = 'cloudig-button cloudig-button-filled'; update.textContent = en ? 'Update Now' : '立即更新'; update.dataset.updateInstall = ''; update.hidden = true;
  const progress = document.createElement('progress'); progress.hidden = true; progress.max = 1; progress.value = 0; progress.setAttribute('aria-label', en ? 'Update download progress' : '更新下载进度');
  footer.append(update, retry, releases, close); dialog.append(title, message, facts, progress, footer); layer.append(dialog);
  let closed = false, controller = null, installing = false;
  const finish = () => {
    if (closed || installing) return; closed = true; controller?.abort(); layer.remove(); background.inert = previousInert; active = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const paint = (result) => {
    const status = Object.hasOwn(messages, result.status) ? result.status : 'invalid_response';
    dialog.dataset.updateStatus = status; dialog.setAttribute('aria-busy', String(status === 'checking')); message.textContent = messages[status];
    retry.disabled = status === 'checking'; releases.hidden = status === 'checking';
    releases.textContent = status === 'available' ? (en ? 'Download Page' : '打开下载页') : (en ? 'View Releases' : '查看发布页');
    update.hidden = status !== 'available' || !result.can_install || !prepare || !install;
    releases.className = `cloudig-button ${update.hidden ? 'cloudig-button-filled' : 'cloudig-button-outline'}`;
    facts.replaceChildren();
    for (const [label, value] of [[en ? 'Current version' : '当前版本', result.current_version], [en ? 'Latest official version' : '最新正式版本', result.latest_version]]) {
      if (typeof value !== 'string' || !value) continue;
      const key = document.createElement('dt'), text = document.createElement('dd'); key.textContent = label; text.textContent = value; text.title = value; facts.append(key, text);
    }
    facts.hidden = !facts.childElementCount;
  };
  update.addEventListener('click', async () => {
    if (closed || installing || update.disabled) return;
    controller?.abort(); controller = new AbortController(); update.disabled = true; retry.disabled = true; releases.hidden = true; progress.hidden = false;
    close.textContent = en ? 'Cancel' : '取消'; message.textContent = en ? 'Downloading and verifying the update…' : '正在下载并验证更新…';
    dialog.dataset.updateStatus = 'downloading';
    try {
      const result = await prepare(controller.signal, value => { if (!closed && value?.total > 0) { progress.max = value.total; progress.value = value.bytes; message.textContent = `${en ? 'Downloading' : '正在下载'} ${Math.round(value.bytes / value.total * 100)}%`; } });
      if (closed || controller.signal.aborted) return;
      installing = true; close.disabled = true; message.textContent = en ? 'Updating… Cloudig will reopen automatically.' : '正在更新，采云将自动重新打开。'; dialog.dataset.updateStatus = 'installing';
      await install(result.capability);
    } catch (error) {
      if (closed) return; installing = false; close.disabled = false; update.disabled = false; retry.disabled = false; progress.hidden = true; releases.hidden = false;
      close.textContent = en ? 'Close' : '关闭'; message.textContent = error?.message || (en ? 'Update failed. Please retry.' : '更新未完成，请重试。'); dialog.dataset.updateStatus = 'failed';
    }
  });
  const run = async () => {
    if (closed || controller && !controller.signal.aborted && retry.disabled) return;
    controller = new AbortController(); paint({ status: 'checking' });
    try { const result = await check(controller.signal); if (!closed) paint(result ?? { status: 'invalid_response' }); }
    catch { if (!closed) paint({ status: 'unavailable' }); }
  };
  retry.addEventListener('click', run); close.addEventListener('click', finish);
  layer.addEventListener('click', event => { if (event.target === layer) finish(); });
  layer.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); finish(); }
    if (event.key !== 'Tab') return;
    const targets = [update, retry, releases, close].filter(node => !node.hidden && !node.disabled);
    if (!targets.length) { event.preventDefault(); return; }
    const index = targets.indexOf(document.activeElement);
    if (event.shiftKey ? index <= 0 : index === targets.length - 1) { event.preventDefault(); (event.shiftKey ? targets.at(-1) : targets[0]).focus(); }
  });
  active = { close: finish, focus: () => close.focus(), element: dialog };
  background.inert = true; host.append(layer); close.focus(); if (initial) paint(initial); else void run();
  return active;
}

export async function checkStartupUpdate({ host, language, check, open }) {
  try {
    const result = await check(); if (result?.status !== 'available') return;
    const en = language === 'en', note = document.createElement('aside'); note.className = 'cloudig-update-notice'; note.setAttribute('role', 'status');
    const text = document.createElement('span'); text.textContent = en ? `Cloudig ${result.latest_version} is available` : `采云 ${result.latest_version} 已发布`;
    const show = document.createElement('button'); show.className = 'cloudig-button cloudig-button-filled'; show.textContent = en ? 'View Update' : '查看更新'; show.onclick = () => { if (open(result) === false) { text.textContent = en ? 'Finish and close the current dialog before updating.' : '请先完成并关闭当前窗口，再更新采云。'; } else note.remove(); };
    const dismiss = document.createElement('button'); dismiss.className = 'cloudig-update-dismiss'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label', en ? 'Dismiss' : '关闭'); dismiss.onclick = () => note.remove();
    note.append(text, show, dismiss); host.append(note);
  } catch { /* Startup checks are optional network work, not startup failures. */ }
}
