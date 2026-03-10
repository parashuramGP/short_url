const createForm = document.getElementById("create-form");
const formMessage = document.getElementById("form-message");
const linksList = document.getElementById("links-list");
const topLinks = document.getElementById("top-links");
const linkTemplate = document.getElementById("link-template");
const resultCard = document.getElementById("result-card");
const resultLink = document.getElementById("result-link");
const resultDestination = document.getElementById("result-destination");
const resultCopy = document.getElementById("result-copy");

const totalLinks = document.getElementById("total-links");
const totalClicks = document.getElementById("total-clicks");
const activeLinks = document.getElementById("active-links");

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
}

function showResult(link) {
  resultCard.classList.remove("hidden");
  resultLink.href = link.shortUrl;
  resultLink.textContent = link.shortUrl;
  resultDestination.textContent = `Redirects to ${link.url}`;
  resultCopy.onclick = async () => {
    await navigator.clipboard.writeText(link.shortUrl);
    formMessage.textContent = `Copied ${link.shortUrl}`;
  };
}

function updateSummary(summary) {
  totalLinks.textContent = summary.totals.linksCreated;
  totalClicks.textContent = summary.totals.totalClicks;
  activeLinks.textContent = summary.totals.activeLinks;

  if (!summary.topLinks.length) {
    topLinks.className = "top-links empty-state";
    topLinks.textContent = "No traffic yet.";
    return;
  }

  topLinks.className = "top-links";
  topLinks.innerHTML = "";

  for (const link of summary.topLinks) {
    const article = document.createElement("article");
    article.className = "top-link";
    const code = document.createElement("strong");
    code.textContent = link.code;

    const shortUrl = document.createElement("p");
    shortUrl.textContent = link.shortUrl;

    const destination = document.createElement("p");
    destination.textContent = link.url;

    const clicks = document.createElement("span");
    clicks.textContent = `${link.clicks} clicks`;

    article.append(code, shortUrl, destination, clicks);
    topLinks.appendChild(article);
  }
}

function renderLinks(links) {
  if (!links.length) {
    linksList.className = "links-list empty-state";
    linksList.textContent = "No shortened URLs yet.";
    return;
  }

  linksList.className = "links-list";
  linksList.innerHTML = "";

  for (const link of links) {
    const node = linkTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".link-code").textContent = link.code;
    node.querySelector(".link-clicks").textContent = `${link.clicks} clicks`;

    const shortAnchor = node.querySelector(".link-short");
    shortAnchor.href = link.shortUrl;
    shortAnchor.textContent = link.shortUrl;

    node.querySelector(".link-url").textContent = link.url;
    node.querySelector(".link-created").textContent = `Created ${new Date(link.createdAt).toLocaleString()}`;
    node.querySelector(".link-expiry").textContent = link.expiresAt
      ? link.isExpired
        ? `Expired ${new Date(link.expiresAt).toLocaleString()}`
        : `Expires ${new Date(link.expiresAt).toLocaleString()}`
      : "No expiration";

    node.querySelector(".copy-button").addEventListener("click", async () => {
      await navigator.clipboard.writeText(link.shortUrl);
      formMessage.textContent = `Copied ${link.shortUrl}`;
    });

    node.querySelector(".delete-button").addEventListener("click", async () => {
      try {
        await request(`/api/links/${encodeURIComponent(link.code)}`, {
          method: "DELETE"
        });
        formMessage.textContent = `Deleted ${link.code}`;
        await loadLinks();
      } catch (error) {
        formMessage.textContent = error.message;
      }
    });

    linksList.appendChild(node);
  }
}

async function loadLinks() {
  const payload = await request("/api/links", { method: "GET" });
  renderLinks(payload.links);
  updateSummary(payload.summary);
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  formMessage.textContent = "Creating short link...";

  const formData = new FormData(createForm);
  const expiresAt = formData.get("expiresAt");

  try {
    const payload = await request("/api/links", {
      method: "POST",
      body: JSON.stringify({
        url: formData.get("url"),
        customCode: formData.get("customCode"),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : ""
      })
    });

    createForm.reset();
    formMessage.textContent = `Created ${payload.link.shortUrl}`;
    showResult(payload.link);
    await loadLinks();
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

function connectStream() {
  const stream = new EventSource("/api/stats/stream");

  stream.addEventListener("stats", async (event) => {
    const summary = JSON.parse(event.data);
    updateSummary(summary);
    await loadLinks();
  });

  stream.onerror = () => {
    stream.close();
    setTimeout(connectStream, 3000);
  };
}

loadLinks().then(connectStream).catch((error) => {
  formMessage.textContent = error.message;
});
