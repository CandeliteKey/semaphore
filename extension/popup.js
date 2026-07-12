"use strict";

const ENDPOINT = "http://localhost:8931/api/cookies";
const SECRET_STORAGE_KEY = "semaphoreSecret";
const ALLOWED_SAME_SITE = new Set([
  "no_restriction",
  "lax",
  "strict",
  "unspecified",
]);

const domainInput = document.querySelector("#domain");
const secretInput = document.querySelector("#secret");
const clipButton = document.querySelector("#clip");
const status = document.querySelector("#status");

function registrableDomain(hostname) {
  const host = hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!host || host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host;
  }

  const labels = host.split(".");
  return labels.length > 1 ? labels.slice(-2).join(".") : host;
}

function normalizeDomain(value) {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").split(/[\/:?#]/, 1)[0]
    .replace(/^\.+|\.+$/g, "");
}

function showStatus(message, kind = "") {
  status.textContent = message;
  status.className = `status ${kind}`.trim();
}

function mapCookie(cookie) {
  const mapped = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };

  if (!cookie.session && typeof cookie.expirationDate === "number") {
    mapped.expirationDate = cookie.expirationDate;
  }
  if (ALLOWED_SAME_SITE.has(cookie.sameSite)) {
    mapped.sameSite = cookie.sameSite;
  }

  return mapped;
}

async function initialize() {
  try {
    const [tabs, stored] = await Promise.all([
      browser.tabs.query({ active: true, currentWindow: true }),
      browser.storage.local.get(SECRET_STORAGE_KEY),
    ]);

    const { url } = tabs[0] ?? {};
    secretInput.value = stored[SECRET_STORAGE_KEY] || "";
    if (!url) {
      showStatus("Could not read the active tab URL.", "error");
      return;
    }

    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      showStatus("Open an HTTP or HTTPS page to clip its cookies.", "error");
      return;
    }
    domainInput.value = registrableDomain(parsed.hostname);
  } catch (error) {
    showStatus(`Could not initialize: ${error.message}`, "error");
  }
}

async function clipCookies() {
  const domain = normalizeDomain(domainInput.value);
  const secret = secretInput.value.trim();

  if (!domain) {
    showStatus("Enter a domain to clip.", "error");
    domainInput.focus();
    return;
  }
  if (!secret) {
    showStatus("Paste the Semaphore shared secret first.", "error");
    secretInput.focus();
    return;
  }

  domainInput.value = domain;
  clipButton.disabled = true;
  showStatus("Clipping cookies…");

  try {
    await browser.storage.local.set({ [SECRET_STORAGE_KEY]: secret });
    const cookies = await browser.cookies.getAll({ domain });
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Semaphore-Secret": secret,
      },
      body: JSON.stringify({
        domain,
        userAgent: navigator.userAgent,
        cookies: cookies.map(mapCookie),
      }),
    });

    if (response.status === 202) {
      showStatus(`Clipped ${cookies.length} cookie${cookies.length === 1 ? "" : "s"} for ${domain}.`, "success");
    } else if (response.status === 401) {
      showStatus("Authentication failed. Check the shared secret.", "error");
    } else if (response.status === 400) {
      showStatus("The server rejected the cookie payload as invalid.", "error");
    } else {
      showStatus(`Server returned unexpected HTTP ${response.status}.`, "error");
    }
  } catch (error) {
    showStatus(`Network error: ${error.message}`, "error");
  } finally {
    clipButton.disabled = false;
  }
}

clipButton.addEventListener("click", clipCookies);
secretInput.addEventListener("change", () => {
  browser.storage.local.set({ [SECRET_STORAGE_KEY]: secretInput.value.trim() });
});

initialize();
