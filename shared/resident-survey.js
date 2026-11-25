/**
 * Resident survey pop-up.
 * The barangay secretary turns surveys ON from the staff "Surveys" page; every ON survey that a resident has
 * not answered yet appears as a pop-up when they open the dashboard (one at a time, each answered once).
 *
 * Survey kinds:
 *   "pets"   - built-in pet survey: do you have pets? how many? name / type / vaccinated for each.
 *              (answers become pet records in the staff Animal Vaccine Tracker)
 *   "custom" - the secretary's own questions: short answer, yes/no, multiple choice, number.
 *
 * Requires: resident-auth-guard.js (residentApiFetch). Place this script AFTER it.
 * Optional: data-api-base="https://api.example.com" on this script tag; else window.API_BASE_URL.
 * Backend: GET /resident/surveys/pending, POST /resident/surveys/:id/respond
 */
(function initResidentSurvey(globalScope) {
  if (globalScope.__residentSurveyInit) return;
  globalScope.__residentSurveyInit = true;

  const doc = globalScope.document;
  const SKIP_KEY = "residentSurveyLater"; // "Maybe later" lasts for this browser tab/session only
  const MAX_PETS = 10;

  function readApiBase() {
    try {
      const sc = doc.currentScript;
      const fromAttr = sc && sc.getAttribute("data-api-base");
      if (fromAttr && String(fromAttr).trim()) return String(fromAttr).trim().replace(/\/$/, "");
    } catch (_e) { /* ignore */ }
    const w = String(globalScope.API_BASE_URL || "").trim();
    return w ? w.replace(/\/$/, "") : "";
  }
  const API_BASE_URL = readApiBase();

  function readSkipped() {
    try { return JSON.parse(globalScope.sessionStorage.getItem(SKIP_KEY) || "[]"); } catch (_e) { return []; }
  }
  function addSkipped(id) {
    try {
      const list = readSkipped();
      if (!list.includes(id)) list.push(id);
      globalScope.sessionStorage.setItem(SKIP_KEY, JSON.stringify(list));
    } catch (_e) { /* ignore */ }
  }

  function injectStyleOnce() {
    if (doc.getElementById("resident-survey-styles")) return;
    const style = doc.createElement("style");
    style.id = "resident-survey-styles";
    style.textContent = `
      .rps-overlay { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55); display: none; align-items: center; justify-content: center; z-index: 8000; padding: 1rem; }
      .rps-overlay.active { display: flex; }
      .rps-card { width: 100%; max-width: 520px; max-height: 92vh; overflow-y: auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 1.5rem; box-shadow: 0 20px 40px rgba(2, 6, 23, 0.25); font-family: 'Inter', sans-serif; color: #1e293b; }
      .rps-icon { font-size: 2.2rem; line-height: 1; margin-bottom: .4rem; }
      .rps-tag { display: inline-block; font-size: .7rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #15803d; background: #dcfce7; border-radius: 999px; padding: .2rem .65rem; margin-bottom: .6rem; }
      .rps-card h2 { margin: 0 0 .35rem; font-size: 1.25rem; color: #043d2e; }
      .rps-card p.rps-sub { margin: 0 0 1.1rem; font-size: .92rem; color: #64748b; line-height: 1.45; white-space: pre-line; }
      .rps-actions { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: 1.1rem; }
      .rps-actions.rps-col { flex-direction: column; }
      .rps-btn { border: 1px solid #cbd5e1; background: #fff; color: #1e293b; border-radius: 10px; padding: .7rem 1rem; font-size: .95rem; font-weight: 600; cursor: pointer; font-family: inherit; }
      .rps-btn:hover:not(:disabled) { background: #f1f5f9; }
      .rps-btn:disabled { opacity: .55; cursor: not-allowed; }
      .rps-btn.primary { background: #16a34a; border-color: #16a34a; color: #fff; }
      .rps-btn.primary:hover:not(:disabled) { background: #15803d; }
      .rps-btn.link { border: none; background: none; color: #64748b; font-weight: 500; text-decoration: underline; padding: .5rem; }
      .rps-btn.grow { flex: 1; }
      .rps-stepper { display: flex; align-items: center; justify-content: center; gap: 1.2rem; margin: 1rem 0; }
      .rps-stepper button { width: 46px; height: 46px; border-radius: 50%; border: 1px solid #cbd5e1; background: #fff; font-size: 1.4rem; cursor: pointer; }
      .rps-stepper button:disabled { opacity: .4; cursor: not-allowed; }
      .rps-stepper output { font-size: 2rem; font-weight: 700; min-width: 2.5rem; text-align: center; color: #043d2e; }
      .rps-pet { border: 1px solid #e2e8f0; border-radius: 12px; padding: .9rem; margin-bottom: .8rem; background: #f8fafc; }
      .rps-pet h3 { margin: 0 0 .6rem; font-size: .95rem; color: #043d2e; }
      .rps-field { margin-bottom: .85rem; }
      .rps-field label.rps-q, .rps-field legend { display: block; font-size: .85rem; font-weight: 600; color: #334155; margin-bottom: .3rem; padding: 0; }
      .rps-field .rps-req { color: #b91c1c; }
      .rps-field input[type="text"], .rps-field input[type="number"] { width: 100%; box-sizing: border-box; padding: .6rem .7rem; border: 1px solid #cbd5e1; border-radius: 8px; font-size: .95rem; font-family: inherit; }
      .rps-field fieldset { border: none; margin: 0; padding: 0; }
      .rps-choices { display: flex; flex-wrap: wrap; gap: .5rem; }
      .rps-choices label { display: inline-flex; align-items: center; gap: .35rem; border: 1px solid #cbd5e1; background: #fff; border-radius: 999px; padding: .4rem .8rem; font-size: .88rem; font-weight: 500; color: #1e293b; cursor: pointer; margin: 0; }
      .rps-choices input:checked + span { font-weight: 700; color: #15803d; }
      .rps-msg { min-height: 1.2rem; margin: .4rem 0 0; font-size: .85rem; color: #b91c1c; }
      .rps-note { font-size: .82rem; color: #475569; background: #f1f5f9; border-radius: 8px; padding: .55rem .7rem; margin: 0 0 .9rem; }
      .rps-hidden { display: none !important; }
    `;
    doc.head.appendChild(style);
  }

  function el(tag, attrs, children) {
    const node = doc.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (v === true) node.setAttribute(k, "");
      else if (v !== false && v != null) node.setAttribute(k, String(v));
    });
    (children || []).forEach((c) => node.appendChild(typeof c === "string" ? doc.createTextNode(c) : c));
    return node;
  }

  let overlay = null;
  let card = null;
  let queue = [];     // surveys still to show (current one first)
  let petCount = 1;

  function ensureModal() {
    if (overlay) return;
    injectStyleOnce();
    card = el("div", { class: "rps-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "rpsTitle", tabindex: "-1" });
    overlay = el("div", { class: "rps-overlay" }, [card]);
    doc.body.appendChild(overlay);
  }
  function show() { ensureModal(); overlay.classList.add("active"); try { card.focus(); } catch (_e) { /* ignore */ } }
  function hide() { if (overlay) overlay.classList.remove("active"); }
  function setCard(nodes) {
    card.textContent = "";
    nodes.forEach((n) => card.appendChild(n));
    card.scrollTop = 0;
  }

  // ---------- flow control ----------
  function current() { return queue[0]; }

  function showCurrent() {
    const s = current();
    if (!s) { hide(); return; }
    petCount = 1;
    if (s.kind === "pets") renderPetStep1(s);
    else renderCustom(s);
    show();
  }

  function skipCurrent() {
    const s = queue.shift();
    if (s) addSkipped(s.id);
    showCurrent();
  }

  function renderDone(message) {
    queue.shift();
    const more = queue.length;
    const nextBtn = el("button", { type: "button", class: "rps-btn primary grow", text: more ? `Next survey (${more} more)` : "Close" });
    nextBtn.addEventListener("click", () => (more ? showCurrent() : hide()));
    setCard([
      el("div", { class: "rps-icon", "aria-hidden": "true", text: "✅" }),
      el("h2", { id: "rpsTitle", text: "Thank you!" }),
      el("p", { class: "rps-sub", text: message }),
      el("div", { class: "rps-actions" }, [nextBtn])
    ]);
    nextBtn.focus();
  }

  function header(s, icon) {
    const nodes = [];
    if (icon) nodes.push(el("div", { class: "rps-icon", "aria-hidden": "true", text: icon }));
    nodes.push(el("span", { class: "rps-tag", text: "Barangay survey" }));
    nodes.push(el("h2", { id: "rpsTitle", text: s.title }));
    nodes.push(el("p", { class: "rps-sub", text: s.description || "" }));
    return nodes;
  }

  // ---------- pets survey ----------
  function renderPetStep1(s) {
    const msg = el("p", { class: "rps-msg", role: "alert" });
    const hasExisting = Array.isArray(s.existingPets) && s.existingPets.length > 0;
    const yesBtn = el("button", { type: "button", class: "rps-btn primary", text: hasExisting ? "Yes, I have more pets to register" : "Yes, I have pets" });
    const noBtn = el("button", { type: "button", class: "rps-btn", text: hasExisting ? "No, my pets are already registered" : "No, I don't have pets" });
    const laterBtn = el("button", { type: "button", class: "rps-btn link", text: "Maybe later" });
    yesBtn.addEventListener("click", () => renderPetStep2(s));
    noBtn.addEventListener("click", async () => {
      noBtn.disabled = yesBtn.disabled = true;
      try {
        await submit(s.id, { hasPets: false, pets: [] });
        renderDone("Your answer has been recorded.");
      } catch (e) {
        msg.textContent = e.message || "Could not save your answer. Please try again.";
        noBtn.disabled = yesBtn.disabled = false;
      }
    });
    laterBtn.addEventListener("click", skipCurrent);
    const nodes = header({
      title: s.title,
      description: s.description || "The barangay is keeping a record of household pets for its anti-rabies and vaccination programs. Do you have any pets at home?"
    }, "🐾");
    if (hasExisting) {
      nodes.push(el("p", { class: "rps-note", text: `Already registered under your name: ${s.existingPets.join(", ")}.` }));
    }
    nodes.push(el("div", { class: "rps-actions rps-col" }, [yesBtn, noBtn, laterBtn]), msg);
    setCard(nodes);
  }

  function renderPetStep2(s) {
    const out = el("output", { "aria-live": "polite", text: String(petCount) });
    const minus = el("button", { type: "button", "aria-label": "Fewer pets", text: "−" });
    const plus = el("button", { type: "button", "aria-label": "More pets", text: "+" });
    function refresh() {
      out.textContent = String(petCount);
      minus.disabled = petCount <= 1;
      plus.disabled = petCount >= MAX_PETS;
    }
    minus.addEventListener("click", () => { petCount = Math.max(1, petCount - 1); refresh(); });
    plus.addEventListener("click", () => { petCount = Math.min(MAX_PETS, petCount + 1); refresh(); });
    refresh();
    const back = el("button", { type: "button", class: "rps-btn", text: "Back" });
    const next = el("button", { type: "button", class: "rps-btn primary grow", text: "Continue" });
    back.addEventListener("click", () => renderPetStep1(s));
    next.addEventListener("click", () => renderPetStep3(s));
    setCard([
      el("div", { class: "rps-icon", "aria-hidden": "true", text: "🐶🐱" }),
      el("h2", { id: "rpsTitle", text: "How many pets do you have?" }),
      el("p", { class: "rps-sub", text: "Count every dog, cat or other animal you keep at home." }),
      el("div", { class: "rps-stepper" }, [minus, out, plus]),
      el("div", { class: "rps-actions" }, [back, next])
    ]);
  }

  function radio(name, value, label, checked) {
    const input = el("input", { type: "radio", name, value, checked: Boolean(checked) });
    return el("label", {}, [input, el("span", { text: label })]);
  }

  function petCardNode(i) {
    const sp = `rpsSpecies${i}`;
    const vc = `rpsVacc${i}`;
    const nameInput = el("input", { type: "text", id: `rpsName${i}`, maxlength: "80", autocomplete: "off", placeholder: "e.g. Brownie" });
    const otherInput = el("input", { type: "text", id: `rpsOther${i}`, maxlength: "60", autocomplete: "off", placeholder: "What kind of pet? e.g. Rabbit" });
    const otherWrap = el("div", { class: "rps-field rps-hidden" }, [el("label", { class: "rps-q", for: `rpsOther${i}`, text: "Kind of pet" }), otherInput]);
    const speciesChoices = el("div", { class: "rps-choices" }, [radio(sp, "Dog", "Dog", true), radio(sp, "Cat", "Cat"), radio(sp, "Other", "Other")]);
    speciesChoices.addEventListener("change", () => {
      const v = card.querySelector(`input[name="${sp}"]:checked`)?.value;
      otherWrap.classList.toggle("rps-hidden", v !== "Other");
    });
    const vaccChoices = el("div", { class: "rps-choices" }, [radio(vc, "yes", "Yes, vaccinated"), radio(vc, "no", "Not yet")]);
    return el("div", { class: "rps-pet" }, [
      el("h3", { text: `Pet ${i + 1}` }),
      el("div", { class: "rps-field" }, [el("label", { class: "rps-q", for: `rpsName${i}`, text: "Pet's name" }), nameInput]),
      el("div", { class: "rps-field" }, [el("fieldset", {}, [el("legend", { text: "Type" }), speciesChoices])]),
      otherWrap,
      el("div", { class: "rps-field" }, [el("fieldset", {}, [el("legend", { text: "Is it vaccinated (e.g. anti-rabies)?" }), vaccChoices])])
    ]);
  }

  function collectPets() {
    const pets = [];
    for (let i = 0; i < petCount; i += 1) {
      const name = (card.querySelector(`#rpsName${i}`)?.value || "").trim();
      const species = card.querySelector(`input[name="rpsSpecies${i}"]:checked`)?.value || "";
      const other = (card.querySelector(`#rpsOther${i}`)?.value || "").trim();
      const vacc = card.querySelector(`input[name="rpsVacc${i}"]:checked`)?.value || "";
      if (!name) return { error: `Please enter the name of pet ${i + 1}.` };
      if (species === "Other" && !other) return { error: `Please say what kind of pet #${i + 1} is.` };
      if (!vacc) return { error: `Please tell us if ${name} is vaccinated.` };
      pets.push({ name, species, speciesOther: species === "Other" ? other : "", vaccinated: vacc === "yes" });
    }
    return { pets };
  }

  function renderPetStep3(s) {
    const list = el("div", {});
    for (let i = 0; i < petCount; i += 1) list.appendChild(petCardNode(i));
    const msg = el("p", { class: "rps-msg", role: "alert" });
    const back = el("button", { type: "button", class: "rps-btn", text: "Back" });
    const save = el("button", { type: "button", class: "rps-btn primary grow", text: "Submit" });
    back.addEventListener("click", () => renderPetStep2(s));
    save.addEventListener("click", async () => {
      msg.textContent = "";
      const r = collectPets();
      if (r.error) { msg.textContent = r.error; return; }
      save.disabled = back.disabled = true;
      save.textContent = "Saving…";
      try {
        await submit(s.id, { hasPets: true, pets: r.pets });
        renderDone(`Your ${r.pets.length === 1 ? "pet has" : r.pets.length + " pets have"} been recorded. Barangay staff will keep the vaccination status updated.`);
      } catch (e) {
        msg.textContent = e.message || "Could not save your answers. Please try again.";
        save.disabled = back.disabled = false;
        save.textContent = "Submit";
      }
    });
    setCard([
      el("h2", { id: "rpsTitle", text: petCount === 1 ? "Tell us about your pet" : "Tell us about your pets" }),
      el("p", { class: "rps-sub", text: "These details help the barangay plan vaccination drives." }),
      list, msg,
      el("div", { class: "rps-actions" }, [back, save])
    ]);
  }

  // ---------- custom survey ----------
  function questionNode(q, idx) {
    const name = `rpsQ_${q.id}`;
    const req = q.required ? el("span", { class: "rps-req", text: " *" }) : null;
    let control;
    if (q.type === "text") {
      control = el("input", { type: "text", id: name, maxlength: "500", autocomplete: "off" });
    } else if (q.type === "number") {
      control = el("input", { type: "number", id: name, inputmode: "decimal", step: "any" });
    } else if (q.type === "yesno") {
      control = el("div", { class: "rps-choices" }, [radio(name, "yes", "Yes"), radio(name, "no", "No")]);
    } else {
      control = el("div", { class: "rps-choices" }, (q.options || []).map((o) => radio(name, o, o)));
    }
    const isGroup = q.type === "yesno" || q.type === "choice";
    const labelText = `${idx + 1}. ${q.label}`;
    if (isGroup) {
      const legend = el("legend", { text: labelText });
      if (req) legend.appendChild(req);
      return el("div", { class: "rps-field" }, [el("fieldset", {}, [legend, control])]);
    }
    const label = el("label", { class: "rps-q", for: name, text: labelText });
    if (req) label.appendChild(req);
    return el("div", { class: "rps-field" }, [label, control]);
  }

  function collectAnswers(s) {
    const answers = {};
    for (const q of s.questions) {
      const name = `rpsQ_${q.id}`;
      let v = "";
      if (q.type === "text" || q.type === "number") v = (card.querySelector(`#${name}`)?.value || "").trim();
      else v = card.querySelector(`input[name="${name}"]:checked`)?.value || "";
      if (!v) {
        if (q.required) return { error: `Please answer: ${q.label}` };
        continue;
      }
      answers[q.id] = v;
    }
    return { answers };
  }

  function renderCustom(s) {
    const form = el("div", {}, s.questions.map(questionNode));
    const msg = el("p", { class: "rps-msg", role: "alert" });
    const later = el("button", { type: "button", class: "rps-btn", text: "Maybe later" });
    const save = el("button", { type: "button", class: "rps-btn primary grow", text: "Submit" });
    later.addEventListener("click", skipCurrent);
    save.addEventListener("click", async () => {
      msg.textContent = "";
      const r = collectAnswers(s);
      if (r.error) { msg.textContent = r.error; return; }
      save.disabled = later.disabled = true;
      save.textContent = "Saving…";
      try {
        await submit(s.id, { answers: r.answers });
        renderDone("Your answers have been recorded.");
      } catch (e) {
        msg.textContent = e.message || "Could not save your answers. Please try again.";
        save.disabled = later.disabled = false;
        save.textContent = "Submit";
      }
    });
    setCard([...header(s, "📋"), form, msg, el("div", { class: "rps-actions" }, [later, save])]);
  }

  // ---------- server calls ----------
  async function submit(surveyId, body) {
    const res = await globalScope.residentApiFetch(`${API_BASE_URL}/resident/surveys/${encodeURIComponent(surveyId)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (_e) { /* ignore */ }
    if (!res.ok || !data?.ok) throw new Error(data?.message || "Could not save your answers. Please try again.");
    return data;
  }

  async function start() {
    if (typeof globalScope.residentApiFetch !== "function") return;
    try {
      const res = await globalScope.residentApiFetch(`${API_BASE_URL}/resident/surveys/pending`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.ok || !Array.isArray(data.surveys)) return;
      const skipped = readSkipped();
      queue = data.surveys.filter((s) => !skipped.includes(s.id));
      if (!queue.length) return;
      ensureModal();
      showCurrent();
    } catch (_e) {
      /* surveys are optional: never get in the resident's way if they cannot load */
    }
  }

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", () => void start());
  else void start();
})(window);
