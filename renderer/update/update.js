const title = document.getElementById("title");
const detail = document.getElementById("detail");
const fill = document.getElementById("fill");
const percent = document.getElementById("percent");
const apply = document.getElementById("apply");

function render(status) {
  const phase = status?.phase || "checking";
  const value = Math.max(0, Math.min(100, Number(status?.percent) || 0));
  fill.style.width = value + "%";
  percent.textContent = value + "%";
  apply.hidden = phase !== "ready";
  if (phase === "ready") {
    title.textContent = "Update ready";
    detail.textContent = "Restart kstream to finish updating.";
  } else if (phase === "error") {
    title.textContent = "Update paused";
    detail.textContent = status?.error || "Could not download the update.";
  } else if (phase === "downloading") {
    title.textContent = "Updating kstream…";
    detail.textContent = "Please wait. kstream will open when this is finished.";
  } else {
    title.textContent = "Checking for updates…";
    detail.textContent = "Please wait. kstream will open when this is finished.";
  }
}

apply.addEventListener("click", () => {
  apply.disabled = true;
  detail.textContent = "Restarting kstream…";
  window.__KSTREAM_DESKTOP_IPC__.invoke("applyDesktopUpdate", { userInitiated: true });
});

window.__KSTREAM_DESKTOP_IPC__.onDesktopUpdate(render);
