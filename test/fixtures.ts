const GITHUB_HIDDEN_ERROR_BLOCK = `
<div data-show-on-forbidden-error hidden>
  <div class="Box">
    <div class="blankslate-container">
      <h3 class="blankslate-heading">Uh oh!</h3>
      <p class="blankslate-description">
        <p class="color-fg-muted my-2 mb-2 ws-normal">There was an error while loading.
        <a class="Link--inTextBlock" href="" aria-label="Please reload this page">Please reload this page</a>.</p>
      </p>
    </div>
  </div>
</div>
`;

export const GITHUB_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><title>unslothai/unsloth</title></head>
<body>
<a class="px-2 py-4" href="#start-of-content">Skip to content</a>
<header class="Header-old">
  <div class="AppHeader-globalBar">
    <a href="/login">Sign in</a>
    <a href="/signup">Sign up</a>
  </div>
</header>
<div class="js-notification-shelf"></div>
<div hidden>
  You signed in with another tab or window. Reload to refresh your session.
  You signed out in another tab or window. Reload to refresh your session.
  You switched accounts on another tab or window. Reload to refresh your session.
  Dismiss alert
</div>
<template>{{ message }}</template>
${GITHUB_HIDDEN_ERROR_BLOCK}
<main id="js-repo-pjax-container">
  ${GITHUB_HIDDEN_ERROR_BLOCK}
  <div id="repository-container-header">
    <a href="/unslothai">unslothai</a> / <a href="/unslothai/unsloth">unsloth</a>
    <a href="/login?return_to=%2Funslothai%2Funsloth">Notifications</a>
    You must be signed in to change notification settings
  </div>
  <div class="repository-content">
    <table aria-labelledby="folders-and-files">
      <tr><th>Name</th><th>Last commit message</th></tr>
      <tr><td><a href="/unslothai/unsloth/tree/main/unsloth">unsloth</a></td><td></td></tr>
    </table>
    <article class="markdown-body entry-content container-lg" itemprop="text">
      <h1>Unsloth Studio</h1>
      <p>Unsloth Studio lets you run and train models locally. Fine-tune and
      run LLMs on Windows, Linux and macOS with a single install command,
      then export to GGUF, Ollama, vLLM or Hugging Face when you are done.</p>
      <h2>Install</h2>
      <pre>curl -fsSL https://unsloth.ai/install.sh | sh</pre>
      <p>See the <a href="https://unsloth.ai/docs">documentation</a> for
      quickstarts, notebooks, and fine-tuning guides for every major model
      family including Llama, Gemma, Qwen and DeepSeek.</p>
    </article>
  </div>
  <div class="Layout-sidebar">
    <h2>Languages</h2>
    <ul>
      <li><a href="/unslothai/unsloth/search?l=javascript">JavaScript 89.3%</a></li>
      <li><a href="/unslothai/unsloth/search?l=python">Python 9.7%</a></li>
    </ul>
  </div>
</main>
<footer>
  <a href="https://docs.github.com">Docs</a>
  <a href="https://github.com/contact">Contact</a>
</footer>
<div aria-live="polite" aria-hidden="true">You can't perform that action at this time.</div>
</body>
</html>
`;
