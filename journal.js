// ===== JOURNAL LOGIC =====

const STORAGE_KEY = "soothespace-journal-entries";

const MOODS = [
  { id: "great",   label: "Great",   emoji: "😄" },
  { id: "okay",    label: "Okay",    emoji: "🙂" },
  { id: "neutral", label: "Neutral", emoji: "😐" },
  { id: "low",     label: "Low",     emoji: "☹️" },
  { id: "anxious", label: "Anxious", emoji: "😰" }
];

let selectedMoodId = null;
let entries = [];
let editingId = null; // null = creating, not editing

function loadEntries() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("Could not parse journal entries:", e);
    return [];
  }
}

function saveEntries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function buildMoodButtons() {
  const container = document.getElementById("moodButtons");
  MOODS.forEach(mood => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mood-btn";
    btn.dataset.moodId = mood.id;
    btn.innerHTML =
      `<span class="mood-emoji">${mood.emoji}</span>` +
      `<span class="mood-label">${mood.label}</span>`;
    container.appendChild(btn);
  });

  container.addEventListener("click", e => {
    const btn = e.target.closest(".mood-btn");
    if (!btn) return;

    selectedMoodId = btn.dataset.moodId;
    document.querySelectorAll(".mood-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    updateSaveButtonState();
  });
}

function updateTodayLabel() {
  const label = document.getElementById("todayLabel");
  const now = new Date();
  const opts = { weekday: "short", year: "numeric", month: "short", day: "numeric" };
  label.textContent = "Today: " + now.toLocaleDateString(undefined, opts);
}

function renderEntries() {
  const listEl = document.getElementById("entriesList");
  const countEl = document.getElementById("entryCount");

  listEl.innerHTML = "";

  if (entries.length === 0) {
    countEl.textContent = "No entries yet";
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "When you save an entry, it will appear here.";
    listEl.appendChild(empty);
    return;
  }

  countEl.textContent = entries.length + (entries.length === 1 ? " entry" : " entries");

  entries.forEach(entry => {
    const moodInfo = MOODS.find(m => m.id === entry.moodId);

    const card = document.createElement("article");
    card.className = "entry-card";

    // Top row: title, date/time, edit + delete buttons
    const top = document.createElement("div");
    top.className = "entry-top";

    const titleMetaWrapper = document.createElement("div");
    const titleEl = document.createElement("div");
    titleEl.className = "entry-title";
    titleEl.textContent = entry.title || "(No title)";

    const metaEl = document.createElement("div");
    metaEl.className = "entry-meta";

    const dateSpan = document.createElement("span");
    dateSpan.textContent = entry.dateText;

    const timeSpan = document.createElement("span");
    timeSpan.textContent = entry.timeText;

    metaEl.appendChild(dateSpan);
    metaEl.appendChild(timeSpan);

    titleMetaWrapper.appendChild(titleEl);
    titleMetaWrapper.appendChild(metaEl);

    // ACTION BUTTONS (edit + delete)
    const actions = document.createElement("div");
    actions.className = "entry-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "entry-edit-btn";
    editBtn.dataset.entryId = entry.id;
    editBtn.innerHTML = `
      <svg class="edit-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M11.3 1.3l3.4 3.4c.4.4.4 1 0 1.4l-7.6 7.6-3.5.9c-.5.1-.9-.3-.8-.8l.9-3.5 7.6-7.6c.4-.4 1-.4 1.4 0zM3.9 9.9L3.3 12l2.1-.6 6.4-6.4-1.5-1.5L3.9 9.9z"></path>
      </svg>
      <span>Edit</span>
    `;

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "entry-delete-btn";
    deleteBtn.dataset.entryId = entry.id;
    deleteBtn.innerHTML = `
      <svg class="delete-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 2.5h6l-.3-1a1 1 0 0 0-1-.8H6.3a1 1 0 0 0-1 .8L5 2.5H3.5a.75.75 0 0 0 0 1.5h9a.75.75 0 0 0 0-1.5H11L10.6 1a2 2 0 0 0-2-1H7.4a2 2 0 0 0-2 1L5 2.5zM5 5v7.5A1.5 1.5 0 0 0 6.5 14h3A1.5 1.5 0 0 0 11 12.5V5a.75.75 0 0 0-1.5 0v7.5a.25.25 0 0 1-.25.25h-3a.25.25 0 0 1-.25-.25V5A.75.75 0 0 0 5 5z"></path>
      </svg>
      <span>Delete</span>
    `;

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    top.appendChild(titleMetaWrapper);
    top.appendChild(actions);

    // Text
    const textEl = document.createElement("p");
    textEl.className = "entry-text";
    textEl.textContent = entry.text;

    // Mood pill
    const moodPill = document.createElement("div");
    moodPill.className = "entry-mood-pill";
    if (moodInfo) {
      moodPill.textContent = `${moodInfo.emoji} ${moodInfo.label}`;
    } else {
      moodPill.textContent = entry.moodId;
    }

    card.appendChild(top);
    card.appendChild(textEl);
    card.appendChild(moodPill);

    listEl.appendChild(card);
  });
}

function updateSaveButtonState() {
  const title = document.getElementById("entryTitle").value.trim();
  const text = document.getElementById("entryText").value.trim();
  const btn = document.getElementById("saveEntryBtn");
  btn.disabled = !(selectedMoodId && title.length > 0 && text.length > 0);
}

function setFormMode(mode) {
  const formMode = document.getElementById("formMode");
  const cancelBtn = document.getElementById("cancelEditBtn");
  const saveBtn = document.getElementById("saveEntryBtn");

  if (mode === "edit") {
    formMode.textContent = "Editing existing entry";
    cancelBtn.style.display = "inline-flex";
    saveBtn.textContent = "Update entry";
  } else {
    formMode.textContent = "New entry";
    cancelBtn.style.display = "none";
    saveBtn.textContent = "Save entry";
    editingId = null;
  }
}

function resetForm() {
  document.getElementById("entryTitle").value = "";
  document.getElementById("entryText").value = "";
  selectedMoodId = null;
  document.querySelectorAll(".mood-btn").forEach(b => b.classList.remove("active"));
  setFormMode("new");
  updateSaveButtonState();
}

function startEditing(entryId) {
  const entry = entries.find(e => e.id === entryId);
  if (!entry) return;

  editingId = entryId;

  const titleInput = document.getElementById("entryTitle");
  const textArea   = document.getElementById("entryText");

  titleInput.value = entry.title || "";
  textArea.value   = entry.text || "";

  selectedMoodId = entry.moodId;
  document.querySelectorAll(".mood-btn").forEach(b => {
    if (b.dataset.moodId === selectedMoodId) b.classList.add("active");
    else b.classList.remove("active");
  });

  setFormMode("edit");
  updateSaveButtonState();

  // scroll to top of form on edit (helpful on mobile)
  titleInput.scrollIntoView({ behavior: "smooth", block: "start" });
}

function deleteEntry(entryId) {
  // if you are editing this entry, reset the form
  if (editingId === entryId) {
    resetForm();
  }

  entries = entries.filter(e => e.id !== entryId);
  saveEntries();
  renderEntries();
}

function setupSaveHandler() {
  const titleInput = document.getElementById("entryTitle");
  const textArea   = document.getElementById("entryText");
  const saveBtn    = document.getElementById("saveEntryBtn");
  const cancelBtn  = document.getElementById("cancelEditBtn");
  const listEl     = document.getElementById("entriesList");

  titleInput.addEventListener("input", updateSaveButtonState);
  textArea.addEventListener("input", updateSaveButtonState);

  saveBtn.addEventListener("click", () => {
    const title = titleInput.value.trim();
    const text  = textArea.value.trim();
    if (!selectedMoodId || !title || !text) return;

    const now = new Date();
    const dateOpts = { year: "numeric", month: "short", day: "numeric" };
    const timeOpts = { hour: "2-digit", minute: "2-digit" };

    const dateText = now.toLocaleDateString(undefined, dateOpts);
    const timeText = now.toLocaleTimeString(undefined, timeOpts);

    if (editingId) {
      // update existing entry
      const entry = entries.find(e => e.id === editingId);
      if (entry) {
        entry.title    = title;
        entry.text     = text;
        entry.moodId   = selectedMoodId;
        entry.dateText = dateText;
        entry.timeText = timeText;
        entry.savedAt  = now.toISOString();
      }
    } else {
      // create new entry
      const newEntry = {
        id: Date.now().toString(),
        title,
        text,
        moodId: selectedMoodId,
        dateText,
        timeText,
        savedAt: now.toISOString()
      };
      entries.push(newEntry);
    }

    saveEntries();
    renderEntries();
    resetForm();
  });

  cancelBtn.addEventListener("click", () => {
    resetForm();
  });

  // event delegation for EDIT + DELETE buttons
  listEl.addEventListener("click", e => {
    const deleteBtn = e.target.closest(".entry-delete-btn");
    if (deleteBtn) {
      const entryId = deleteBtn.dataset.entryId;
      const ok = confirm("Delete this entry? This cannot be undone.");
      if (ok) deleteEntry(entryId);
      return;
    }

    const editBtn = e.target.closest(".entry-edit-btn");
    if (editBtn) {
      const entryId = editBtn.dataset.entryId;
      startEditing(entryId);
    }
  });
}

// ===== NAVBAR HAMBURGER =====
function setupNavbarToggle() {
  const nav = document.querySelector(".ss-nav");
  const toggleBtn = document.querySelector(".ss-menu-toggle");
  if (!nav || !toggleBtn) return;

  toggleBtn.addEventListener("click", () => {
    nav.classList.toggle("open");
  });
}

// ===== INIT =====
document.addEventListener("DOMContentLoaded", () => {
  // navbar
  setupNavbarToggle();

  // journal
  entries = loadEntries();
  buildMoodButtons();
  updateTodayLabel();
  renderEntries();
  setupSaveHandler();
  updateSaveButtonState();
  setFormMode("new");
});
