(() => {
  const versionEl = document.getElementById('version');
  const installPathEl = document.getElementById('install-path');
  const statusEl = document.getElementById('status');
  const btnInstall = document.getElementById('btn-install');
  const btnPortable = document.getElementById('btn-portable');

  function setStatus(message, isError = false) {
    if (!message) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.classList.remove('error');
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = message;
    statusEl.classList.toggle('error', isError);
  }

  function setBusy(busy) {
    btnInstall.disabled = busy;
    btnPortable.disabled = busy;
  }

  async function init() {
    if (!window.kstreamSetup) {
      setStatus('setup bridge missing — restart the app.', true);
      return;
    }

    try {
      const info = await window.kstreamSetup.getInfo();
      versionEl.textContent = info.version || '1.0';
      installPathEl.textContent = info.installDirShort || 'appdata\\programs\\kstream';
      btnInstall.disabled = false;
      btnPortable.disabled = false;
    } catch (err) {
      setStatus(err?.message || 'could not load setup info.', true);
    }
  }

  btnInstall.addEventListener('click', async () => {
    setBusy(true);
    setStatus('installing…');
    try {
      const result = await window.kstreamSetup.install();
      if (result?.dev) {
        setStatus('dev mode — continuing without copying files.');
        return;
      }
      setStatus('launching installed app…');
    } catch (err) {
      setStatus(err?.message || 'install failed.', true);
      setBusy(false);
    }
  });

  btnPortable.addEventListener('click', async () => {
    setBusy(true);
    setStatus('starting portable mode…');
    try {
      await window.kstreamSetup.portable();
    } catch (err) {
      setStatus(err?.message || 'could not start portable mode.', true);
      setBusy(false);
    }
  });

  init();
})();
