const root = document.documentElement;
const themeToggle = document.getElementById('site-theme-toggle');
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const themeKey = 'dicom-pdf-theme';

let preferredTheme;
try {
  preferredTheme = localStorage.getItem(themeKey);
} catch {
  // The theme can still change for this page if storage is unavailable.
}

function applyTheme() {
  const theme = preferredTheme || (systemTheme.matches ? 'dark' : 'light');
  root.dataset.theme = theme;
  themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}

applyTheme();
systemTheme.addEventListener('change', applyTheme);
themeToggle.addEventListener('click', () => {
  preferredTheme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  try {
    localStorage.setItem(themeKey, preferredTheme);
  } catch {
    // Keep the selection in memory for this page.
  }
});

const menuToggle = document.getElementById('site-menu-toggle');
const navigation = document.getElementById('site-nav');

function setMenuOpen(open) {
  root.toggleAttribute('data-menu-open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
}

menuToggle.addEventListener('click', () => setMenuOpen(!root.hasAttribute('data-menu-open')));
navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) setMenuOpen(false);
});
document.addEventListener('pointerdown', (event) => {
  if (!navigation.contains(event.target) && !menuToggle.contains(event.target)) setMenuOpen(false);
});

const toc = document.getElementById('site-toc');
const tocList = document.getElementById('site-toc-list');
const headings = document.querySelectorAll('#main-content h2[id], #main-content h3[id]');
for (const heading of headings) {
  const item = document.createElement('li');
  if (heading.localName === 'h3') item.className = 'toc-subsection';
  const link = document.createElement('a');
  link.href = `#${encodeURIComponent(heading.id)}`;
  link.textContent = heading.textContent;
  item.append(link);
  tocList.append(item);
}
toc.hidden = headings.length === 0;

const search = document.getElementById('site-search');
const searchInput = document.getElementById('site-search-input');
const searchResults = document.getElementById('site-search-results');
let searchIndex;
let searchRequest = 0;

function closeSearch() {
  searchRequest++;
  searchResults.hidden = true;
}

async function loadSearchIndex() {
  const response = await fetch(search.dataset.searchIndex);
  if (!response.ok) throw new Error(`Search index returned HTTP ${response.status}.`);
  return (await response.json()).map(({ title, url, text }) => ({
    title,
    url,
    titleText: title.toLowerCase(),
    bodyText: text.toLowerCase(),
  }));
}

function renderSearchResults(matches, message) {
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = message;
  const list = document.createElement('ul');
  for (const { title, url } of matches) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = url;
    link.textContent = title;
    item.append(link);
    list.append(item);
  }
  searchResults.replaceChildren(status, list);
  searchResults.hidden = false;
}

async function updateSearch() {
  const terms = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    closeSearch();
    return;
  }
  const request = ++searchRequest;
  try {
    searchIndex ??= loadSearchIndex();
    const documents = await searchIndex;
    if (request !== searchRequest) return;
    const matches = documents.filter(({ titleText, bodyText }) =>
      terms.every((term) => titleText.includes(term) || bodyText.includes(term)));
    const titleMatches = ({ titleText }) => terms.filter((term) => titleText.includes(term)).length;
    matches.sort((first, second) => titleMatches(second) - titleMatches(first));
    const count = matches.length;
    const message = count === 0 ? 'No matching documents' : `${count} matching document${count === 1 ? '' : 's'}`;
    renderSearchResults(matches, message);
  } catch {
    searchIndex = undefined;
    if (request === searchRequest) renderSearchResults([], 'Search is temporarily unavailable');
  }
}

searchInput.addEventListener('input', updateSearch);
searchInput.addEventListener('focus', updateSearch);
search.addEventListener('focusout', (event) => {
  if (!search.contains(event.relatedTarget)) closeSearch();
});
search.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!searchResults.hidden) searchResults.querySelector('a')?.focus();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!searchResults.hidden) {
    searchInput.focus();
    closeSearch();
  } else if (root.hasAttribute('data-menu-open')) {
    setMenuOpen(false);
    menuToggle.focus();
  }
});
