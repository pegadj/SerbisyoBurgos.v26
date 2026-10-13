/**
 * Resident "View Profile" — profile settings + progress modals, load/save, avatar upload.
 * Requires: routes.js, resident-auth-guard.js (residentApiFetch), resident-sidebar-profile.js (optional).
 * Optional: data-api-base="https://api.example.com" on this script tag; else window.API_BASE_URL.
 */
(function initResidentProfileModal(globalScope) {
  if (globalScope.__residentProfileModalInit) return;
  globalScope.__residentProfileModalInit = true;

  function readApiBase() {
    try {
      const sc = globalScope.document?.currentScript;
      const fromAttr = sc && sc.getAttribute("data-api-base");
      if (fromAttr && String(fromAttr).trim()) return String(fromAttr).trim().replace(/\/$/, "");
    } catch (_e) {
      /* ignore */
    }
    const w = String(globalScope.API_BASE_URL || "").trim();
    return w ? w.replace(/\/$/, "") : "https://sb-draft1.onrender.com";
  }

  function resolveFileUrl(url) {
    const u = String(url || "").trim();
    if (!u) return u;
    if (!/^https?:\/\//i.test(u)) {
      const base = readApiBase();
      const absolute = `${base}${u.startsWith("/") ? "" : "/"}${u}`;
      return appendAccessTokenParam(absolute);
    }
    return appendAccessTokenParam(u);
  }

  // <img>/<iframe> loads can't send an Authorization header, so the token
  // travels as a query param instead — same pattern residentSseUrl() uses
  // for EventSource, which has the same limitation.
  function appendAccessTokenParam(url) {
    try {
      const token = globalScope.getResidentAccessToken?.();
      if (!token) return url;
      const sep = url.includes("?") ? "&" : "?";
      return `${url}${sep}access_token=${encodeURIComponent(token)}`;
    } catch (_e) {
      return url;
    }
  }

  const API_BASE_URL = readApiBase();

  function injectStyleOnce() {
    if (globalScope.document.getElementById("resident-profile-modal-styles")) return;
    const style = globalScope.document.createElement("style");
    style.id = "resident-profile-modal-styles";
    style.textContent = `
      .resident-profile-overlay {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.45);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 7000;
        padding: 1rem;
      }
      .resident-profile-overlay.active {
        display: flex;
      }
      .resident-profile-overlay .modal-content {
        width: 100%;
        max-width: 420px;
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        padding: 1.5rem;
        box-shadow: 0 20px 40px rgba(2, 6, 23, 0.2);
      }
      .resident-profile-overlay#profileModal .modal-content {
        max-width: 500px;
      }
    `;
    globalScope.document.head.appendChild(style);
  }

  function injectModalsOnce() {
    if (globalScope.document.getElementById("profileModal")) return;
    const host = globalScope.document.body;
    if (!host) return;
    host.insertAdjacentHTML(
      "beforeend",
      `
<div id="profileModal" class="resident-profile-overlay" role="dialog" aria-modal="true">
  <div class="modal-content">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; border-bottom: 1px solid #e2e8f0; padding-bottom: 1rem;">
      <h2 style="font-size: 1.25rem; color: var(--brand-dark, #043d2e); font-weight: 700;">Profile Settings</h2>
      <button type="button" data-rp-close-profile style="background: none; border: none; font-size: 1.5rem; cursor: pointer; color: var(--text-muted, #64748b);">&times;</button>
    </div>
    <form id="profileForm">
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div style="text-align: center; margin-bottom: 1rem;">
          <div class="user-avatar" style="width: 80px; height: 80px; font-size: 2rem; margin: 0 auto 0.5rem;">?</div>
          <p style="font-size: 0.85rem; color: var(--brand-green, #16a34a); cursor: pointer; font-weight: 600;" data-rp-trigger-photo>Change Photo</p>
          <input type="file" id="profilePhotoInput" accept="image/*" style="display: none;">
        </div>
        <div class="form-group">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Full Name</label>
          <input type="text" value="" style="width: 100%; padding: 0.75rem; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #f8fafc;" readonly disabled>
        </div>
        <div class="form-group">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Email Address</label>
          <input type="email" placeholder="user@gmail.com" style="width: 100%; padding: 0.75rem; border: 1px solid #e2e8f0; border-radius: 8px;">
        </div>
        <div class="form-group">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Password</label>
          <input type="password" placeholder="Enter new password" style="width: 100%; padding: 0.75rem; border: 1px solid #e2e8f0; border-radius: 8px;">
          <p data-rp-password-length-hint style="font-size: 0.8rem; margin-top: 4px; min-height: 1.1rem;"></p>
        </div>
        <div class="form-group">
          <label style="display: block; font-size: 0.85rem; font-weight: 600; margin-bottom: 4px;">Contact Number</label>
          <input type="tel" placeholder="0912 345 6789" style="width: 100%; padding: 0.75rem; border: 1px solid #e2e8f0; border-radius: 8px;">
        </div>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 0.75rem; margin-top: 2rem;">
        <button type="button" data-rp-cancel-profile style="padding: 0.75rem 1.25rem; border-radius: 10px; border: none; background: #f1f5f9; color: #64748b; font-weight: 600; cursor: pointer;">Cancel</button>
        <button type="submit" style="padding: 0.75rem 1.25rem; border-radius: 10px; border: none; background: var(--brand-green, #16a34a); color: white; font-weight: 600; cursor: pointer;">Save Changes</button>
      </div>
    </form>
  </div>
</div>
<div id="profileProgressModal" class="resident-profile-overlay" role="dialog" aria-modal="true">
  <div class="modal-content" style="max-width: 420px;">
    <h2 style="font-size: 1.25rem; color: var(--brand-dark, #043d2e); font-weight: 700; margin-bottom: 1rem;">Profile Update</h2>
    <p data-rp-progress-text style="color: var(--text-main, #1e293b); margin-bottom: 1.5rem;">Please wait…</p>
    <div style="display: flex; justify-content: flex-end;">
      <button type="button" data-rp-close-progress style="padding: 0.75rem 1.5rem; border-radius: 10px; border: none; background: var(--brand-green, #16a34a); color: white; font-weight: 600; cursor: pointer;">OK</button>
    </div>
  </div>
</div>
`
    );
  }

  let pendingProfileAvatarFile = null;
  let wired = false;

  function initialsForProfileModal(fullName) {
    const s = String(fullName || "").trim();
    if (!s) return "?";
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const a = parts[0][0] || "";
      const b = parts[parts.length - 1][0] || "";
      const out = (a + b).toUpperCase();
      return out || "?";
    }
    const one = parts[0] || "";
    const letter = one[0] || "?";
    return (letter + letter).toUpperCase();
  }

  function applyProfileModalAvatar(avatarUrl, fullName) {
    const avatar = globalScope.document.querySelector("#profileModal .user-avatar");
    if (!avatar) return;
    const u = resolveFileUrl(avatarUrl);
    if (u) {
      const bust = u.includes("?") ? "&" : "?";
      const urlWithBust = `${u}${bust}cb=${Date.now()}`;
      avatar.style.backgroundImage = "url(" + JSON.stringify(urlWithBust) + ")";
      avatar.style.backgroundSize = "cover";
      avatar.style.backgroundPosition = "center";
      avatar.textContent = "";
      avatar.style.color = "transparent";
    } else {
      avatar.style.backgroundImage = "";
      avatar.style.backgroundSize = "";
      avatar.style.backgroundPosition = "";
      avatar.textContent = initialsForProfileModal(fullName);
      avatar.style.color = "";
    }
  }

  function getProfileFormInputs() {
    const form = globalScope.document.getElementById("profileForm");
    if (!form) return null;
    return {
      form,
      fullNameInput: form.querySelector('input[type="text"]'),
      emailInput: form.querySelector('input[type="email"]'),
      passwordInput: form.querySelector('input[type="password"]'),
      telInput: form.querySelector('input[type="tel"]')
    };
  }

  function normalizeProfileEmail(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function mergeResidentAuthUser(partial) {
    try {
      const raw = globalScope.sessionStorage.getItem("residentAuth");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      parsed.user = { ...(parsed.user || {}), ...partial };
      globalScope.sessionStorage.setItem("residentAuth", JSON.stringify(parsed));
      if (typeof globalScope.applyResidentSidebarProfile === "function") {
        void globalScope.applyResidentSidebarProfile({ skipHydrate: true });
      }
    } catch (_e) {
      /* ignore */
    }
  }

  async function loadResidentProfileIntoModal() {
    const inputs = getProfileFormInputs();
    if (!inputs || typeof globalScope.residentApiFetch !== "function") return;
    try {
      const response = await globalScope.residentApiFetch(`${API_BASE_URL}/resident/profile`);
      const result = await response.json();
      if (!response.ok || !result?.ok) {
        throw new Error(result?.message || "Unable to load profile.");
      }
      if (inputs.fullNameInput) inputs.fullNameInput.value = result.fullName || "";
      if (inputs.emailInput) inputs.emailInput.value = result.email || "";
      if (inputs.telInput) inputs.telInput.value = result.contactNumber != null ? String(result.contactNumber) : "";
      applyProfileModalAvatar(result.avatarUrl, result.fullName);
    } catch (err) {
      console.warn(err);
    }
  }

  function closeProfileModal() {
    const profileModal = globalScope.document.getElementById("profileModal");
    if (profileModal) profileModal.classList.remove("active");
  }

  function closeProfileProgressModal() {
    const el = globalScope.document.getElementById("profileProgressModal");
    if (el) el.classList.remove("active");
  }

  function previewProfilePhoto(event) {
    const file = event.target.files && event.target.files[0];
    if (!file || !file.type.startsWith("image/")) {
      globalScope.alert("Please select a valid image file.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      globalScope.alert("Image size too large. Max 5MB.");
      return;
    }
    pendingProfileAvatarFile = file;
    const reader = new FileReader();
    reader.onload = function (e) {
      const avatar = globalScope.document.querySelector("#profileModal .user-avatar");
      if (!avatar || !e.target?.result) return;
      avatar.style.backgroundImage = `url(${e.target.result})`;
      avatar.style.backgroundSize = "cover";
      avatar.style.backgroundPosition = "center";
      avatar.textContent = "";
      avatar.style.color = "transparent";
    };
    reader.readAsDataURL(file);
  }

  function wire() {
    if (wired) return;
    if (typeof globalScope.residentApiFetch !== "function") {
      console.warn("[resident-profile-modal] residentApiFetch missing; load resident-auth-guard.js first.");
      return;
    }
    injectStyleOnce();
    injectModalsOnce();

    const profileModal = globalScope.document.getElementById("profileModal");
    const profileProgressModal = globalScope.document.getElementById("profileProgressModal");
    const profileProgressText = globalScope.document.querySelector("[data-rp-progress-text]");
    const profileProgressTitle = profileProgressModal?.querySelector("h2");

    const photoInput = globalScope.document.getElementById("profilePhotoInput");
    if (photoInput) {
      photoInput.addEventListener("change", previewProfilePhoto);
    }
    globalScope.document.querySelector("[data-rp-trigger-photo]")?.addEventListener("click", () => {
      globalScope.document.getElementById("profilePhotoInput")?.click();
    });
    globalScope.document.querySelector("[data-rp-close-profile]")?.addEventListener("click", closeProfileModal);
    globalScope.document.querySelector("[data-rp-cancel-profile]")?.addEventListener("click", closeProfileModal);
    globalScope.document.querySelector("[data-rp-close-progress]")?.addEventListener("click", closeProfileProgressModal);

    const residentProfileBtn = globalScope.document.getElementById("residentProfileBtn");
    if (residentProfileBtn && profileModal) {
      residentProfileBtn.addEventListener("click", () => {
        pendingProfileAvatarFile = null;
        const pi = globalScope.document.getElementById("profilePhotoInput");
        if (pi) pi.value = "";
        profileModal.classList.add("active");
        void loadResidentProfileIntoModal();
      });
    }

    globalScope.addEventListener("click", (event) => {
      if (event.target === profileModal) closeProfileModal();
      if (event.target === profileProgressModal) closeProfileProgressModal();
    });

    const profileForm = globalScope.document.getElementById("profileForm");
    if (profileForm) {
      const pwdLenHint = globalScope.document.querySelector("[data-rp-password-length-hint]");
      const pwdInputEl = profileForm.querySelector('input[type="password"]');
      function syncProfilePasswordLengthHint() {
        if (!pwdLenHint || !pwdInputEl) return;
        const pw = String(pwdInputEl.value || "");
        if (!pw.length) {
          pwdLenHint.textContent = "";
          pwdLenHint.style.color = "";
          return;
        }
        if (pw.length < 8) {
          pwdLenHint.textContent = "Password must be at least 8 characters.";
          pwdLenHint.style.color = "#b91c1c";
          return;
        }
        pwdLenHint.textContent = "Minimum length requirement met.";
        pwdLenHint.style.color = "#166534";
      }
      pwdInputEl?.addEventListener("input", syncProfilePasswordLengthHint);

      profileForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        const inputs = getProfileFormInputs();
        if (!inputs || !inputs.emailInput || !inputs.telInput) return;

        const email = normalizeProfileEmail(inputs.emailInput.value);
        const contactRaw = String(inputs.telInput.value || "").trim();
        const newPassword = String(inputs.passwordInput?.value || "");

        if (!email) {
          globalScope.alert("Email address is required.");
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          globalScope.alert("Please enter a valid email address.");
          return;
        }
        if (newPassword && newPassword.length < 8) {
          globalScope.alert("New password must be at least 8 characters.");
          return;
        }

        closeProfileModal();
        if (profileProgressTitle) profileProgressTitle.textContent = "Profile Update";
        if (profileProgressText) profileProgressText.textContent = "Saving your profile…";
        if (profileProgressModal) profileProgressModal.classList.add("active");

        const jsonHeaders = { "Content-Type": "application/json" };
        const photoFile = pendingProfileAvatarFile;

        try {
          if (photoFile) {
            if (profileProgressText) profileProgressText.textContent = "Uploading profile photo…";
            const ab = await photoFile.arrayBuffer();
            const ct = photoFile.type || "application/octet-stream";
            const avatarRes = await globalScope.residentApiFetch(`${API_BASE_URL}/resident/profile/avatar`, {
              method: "POST",
              headers: { "Content-Type": ct },
              body: ab
            });
            const avatarResult = await avatarRes.json();
            if (!avatarRes.ok || !avatarResult?.ok) {
              const parts = [avatarResult?.message, avatarResult?.detail].filter(Boolean);
              throw new Error(parts.length ? parts.join(" — ") : "Unable to upload profile photo.");
            }
            applyProfileModalAvatar(avatarResult.avatarUrl, String(inputs.fullNameInput?.value || "").trim());
            mergeResidentAuthUser({ avatarUrl: avatarResult.avatarUrl });
            pendingProfileAvatarFile = null;
            if (photoInput) photoInput.value = "";
          }

          if (profileProgressText) profileProgressText.textContent = "Saving your profile…";

          const patchBody = {
            email: email || inputs.emailInput.value.trim(),
            contactNumber: contactRaw === "" ? null : contactRaw
          };
          const patchRes = await globalScope.residentApiFetch(`${API_BASE_URL}/resident/profile`, {
            method: "PATCH",
            headers: jsonHeaders,
            body: JSON.stringify(patchBody)
          });
          const patchResult = await patchRes.json();
          if (!patchRes.ok || !patchResult?.ok) {
            const parts = [patchResult?.message, patchResult?.detail].filter(Boolean);
            throw new Error(parts.length ? parts.join(" — ") : "Unable to save profile.");
          }
          mergeResidentAuthUser({
            email: patchResult.email,
            fullName: patchResult.fullName,
            avatarUrl: patchResult.avatarUrl
          });
          applyProfileModalAvatar(patchResult.avatarUrl, patchResult.fullName);

          if (newPassword) {
            if (profileProgressText) profileProgressText.textContent = "Updating password…";
            const passRes = await globalScope.residentApiFetch(`${API_BASE_URL}/resident/change-password`, {
              method: "POST",
              headers: jsonHeaders,
              body: JSON.stringify({ newPassword })
            });
            const passResult = await passRes.json();
            if (!passRes.ok || !passResult?.ok) {
              const parts = [passResult?.message, passResult?.detail].filter(Boolean);
              throw new Error(parts.length ? parts.join(" — ") : "Unable to update password.");
            }
            if (inputs.passwordInput) inputs.passwordInput.value = "";
            const hintAfter = globalScope.document.querySelector("[data-rp-password-length-hint]");
            if (hintAfter) {
              hintAfter.textContent = "";
              hintAfter.style.color = "";
            }
          }

          if (profileProgressText) {
            profileProgressText.textContent = newPassword
              ? "Profile and password were updated successfully."
              : "Profile updated successfully.";
          }
        } catch (err) {
          const msg = err?.message || "Something went wrong.";
          if (profileProgressText) profileProgressText.textContent = msg;
        }
      });
    }

    globalScope.closeProfileModal = closeProfileModal;
    globalScope.closeProfileProgressModal = closeProfileProgressModal;
    globalScope.previewProfilePhoto = previewProfilePhoto;

    wired = true;
  }

  function boot() {
    wire();
  }

  if (globalScope.document.readyState === "loading") {
    globalScope.document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);