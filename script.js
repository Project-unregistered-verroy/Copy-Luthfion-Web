const CookieStorage = {
  set(name, value, days = 1) {
    const exp = new Date(Date.now() + days * 86_400_000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)};path=/;SameSite=Strict;expires=${exp}`;
  },
  get(name) {
    const match = document.cookie.match(
      new RegExp(`(?:^|;\\s*)${name}=([^;]*)`),
    );
    return match ? decodeURIComponent(match[1]) : null;
  },
  delete(name) {
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
  },
};

const LocalStore = {
  set(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  },
  get(key, fallback = null) {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  },
  delete(key) {
    localStorage.removeItem(key);
  },
};

const IndexedDBStore = {
  _db: null,
  async init() {
    return new Promise((resolve) => {
      const req = indexedDB.open("FitneZ", 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        [
          "authLogs",
          "payments",
          "attendance",
          "exercises",
          "earnings",
          "clients",
        ].forEach((t) => {
          if (!db.objectStoreNames.contains(t))
            db.createObjectStore(t, { keyPath: "id" });
        });
      };
      req.onsuccess = () => resolve((this._db = req.result));
    });
  },
  async save(table, records) {
    if (!this._db) return;
    const store = this._db.transaction(table, "readwrite").objectStore(table);
    store.clear();
    records.forEach((r) => store.add(r));
  },
  async get(table) {
    if (!this._db) return null;
    return new Promise((res) => {
      const req = this._db
        .transaction(table, "readonly")
        .objectStore(table)
        .getAll();
      req.onsuccess = () => res(req.result.length ? req.result : null);
    });
  },
};

const State = {
  role: null,
  token: null,
  authLogs: [],
  payments: [],
  attendance: [],
  exercises: [],
  earnings: [],
  clients: [],
};

const API = {
  async get(table) {
    const token = LocalStore.get("fitz_token");
    const res = await fetch(`/api/${table}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
    });
    if (res.status === 401) {
      Toast.show("Session expired. Please login again.", "error");
      return Auth.logout();
    }
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || `Failed to fetch ${table}`);
    }
    const data = await res.json();
    await IndexedDBStore.save(table, data);
    return data;
  },
  async post(table, body) {
    const token = LocalStore.get("fitz_token");
    const res = await fetch(`/api/${table}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      credentials: "include",
    });
    if (res.status === 401) {
      Toast.show("Session expired. Please login again.", "error");
      Auth.logout();
      throw new Error("Unauthorized");
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to save");
    }
    return data;
  },
  async delete(table, id) {
    const token = LocalStore.get("fitz_token");
    const res = await fetch(`/api/${table}/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
    });
    if (res.status === 401) {
      Toast.show("Session expired. Please login again.", "error");
      Auth.logout();
      throw new Error("Unauthorized");
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to delete");
    }
    return data;
  },
};

const RealTime = {
  init() {
    // 0. Session Monitor - Check for session expiration every 60 seconds
    setInterval(() => {
      const expiresAt = LocalStore.get("fitz_session_expires");
      if (expiresAt && new Date(expiresAt) < new Date()) {
        Toast.show("Session expired. Please login again.", "error");
        Auth.logout();
      }
    }, 60000);

    // 1. Polling
    setInterval(() => {
      if (window.location.pathname.includes("admin")) {
        const currentSection = LocalStore.get("fitz_last_section", "overview");
        if (currentSection === "overview") Admin.loadOverview().catch((err) => console.warn("Polling error:", err));
      }
    }, 10000);

    // 2. Server-Sent Events (SSE)
    try {
      const evtSource = new EventSource("/api/sse");
      evtSource.onmessage = (event) => {
        Toast.show(`🔔 ${event.data}`, "info");
      };
      evtSource.onerror = () => console.warn("SSE connection error");
    } catch (err) {
      console.warn("SSE initialization failed:", err);
    }

    // 3. WebSockets
    try {
      const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${wsProto}//${location.host}`);
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "SYNC_UPDATE") {
            Toast.show("Live Update Received", "success");
            if (window.location.pathname.includes("admin")) {
              Admin.loadPayments().catch((err) => console.warn("Payment update error:", err));
              Admin.loadAttendance().catch((err) => console.warn("Attendance update error:", err));
            }
          }
        } catch (err) {
          console.warn("WS message parse error:", err);
        }
      };
      ws.onerror = () => console.warn("WebSocket connection error");
    } catch (err) {
      console.warn("WebSocket initialization failed:", err);
    }
  },
};

const Toast = {
  _timer: null,
  show(msg, type = "info") {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.className = `toast toast-${type}`;
    el.style.display = "block";
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      el.style.display = "none";
    }, 3000);
  },
};

const UI = {
  showSection(sectionName) {
    document
      .querySelectorAll(".section")
      .forEach((s) => s.classList.remove("active"));
    const section = document.getElementById(sectionName);
    if (section) section.classList.add("active");
  },
  toggle(elementId) {
    const el = document.getElementById(elementId);
    if (el) el.style.display = el.style.display === "none" ? "block" : "none";
  },
  hide(elementId) {
    const el = document.getElementById(elementId);
    if (el) el.style.display = "none";
  },
  highlightNav(section) {
    document.querySelectorAll(".nav-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.section === section);
    });
  },
  toggleMenu() {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) sidebar.classList.toggle("menu-open");
  },
  closeMenu() {
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) sidebar.classList.remove("menu-open");
  },
  closeMenuOutside(event) {
    const sidebar = document.querySelector(".sidebar");
    const hamburger = document.querySelector(".hamburger");
    if (sidebar && hamburger && 
        !sidebar.contains(event.target) && 
        !hamburger.contains(event.target)) {
      sidebar.classList.remove("menu-open");
    }
  },
};

const Router = {
  async tab(section) {
    try {
      UI.closeMenu();
      const role = State.role || CookieStorage.get("fitz_role");
      if (!role) return Auth.logout();

      UI.showSection(`${role}-${section}`);
      UI.highlightNav(section);
      LocalStore.set("fitz_last_section", section);

      if (role === "admin") {
        if (section === "overview") await Admin.loadOverview();
        else if (section === "auth-logs") await Admin.loadAuthLogs();
        else if (section === "payments") await Admin.loadPayments();
        else if (section === "attendance") await Admin.loadAttendance();
      } else if (role === "trainer") {
        if (section === "workouts") await Trainer.loadClients();
        else if (section === "exercise") await Trainer.loadExercises();
        else if (section === "nutrition") await Trainer.loadEarnings();
        else if (section === "meals") Trainer.loadMeals();
      }
    } catch (err) {
      Toast.show("Error loading section", "error");
    }
  },
};

const Auth = {
  async login() {
    try {
      const user = document.getElementById("login-user").value.trim();
      const pass = document.getElementById("login-pass").value;

      if (!user || !pass) {
        Toast.show("Please enter username and password", "error");
        return;
      }

      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, pass }),
        credentials: "include", // Include cookies in request
      });

      const data = await res.json();

      if (res.ok) {
        // Store session information in localStorage
        LocalStore.set("fitz_token", data.token); // Store token in localStorage
        LocalStore.set("fitz_session_expires", data.expiresAt);
        LocalStore.set("fitz_username", data.username || user);
        
        // Also store in cookies for persistence across tab closures (HttpOnly done by server)
        CookieStorage.set("fitz_role", data.role, 1);
        CookieStorage.set("fitz_username", data.username || user, 1);

        Toast.show(`Welcome ${data.username || user}! ✓`, "success");
        setTimeout(() => {
          window.location.href =
            data.role === "admin" ? "/admin.html" : "/trainer.html";
        }, 500);
      } else if (res.status === 429) {
        Toast.show(
          `${data.error} (Retry in ${data.remainingTime}s)`,
          "error"
        );
      } else {
        Toast.show(data.error || "Login failed", "error");
      }
    } catch (err) {
      console.error("Login error:", err);
      Toast.show("Connection error", "error");
    }
  },
  check() {
    const role = CookieStorage.get("fitz_role");
    const expiresAt = LocalStore.get("fitz_session_expires");

    // Check if session has expired
    if (role && expiresAt) {
      if (new Date(expiresAt) < new Date()) {
        this.logout();
        return null;
      }
    }

    return role;
  },
  async logout() {
    try {
      const token = LocalStore.get("fitz_token");

      // Call server logout endpoint to revoke session
      if (token) {
        await fetch("/api/logout", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          credentials: "include",
        }).catch(() => {}); // Ignore errors during logout
      }
    } catch (err) {
      console.error("Logout error:", err);
    } finally {
      // Clear all session data
      LocalStore.delete("fitz_token");
      LocalStore.delete("fitz_session_expires");
      LocalStore.delete("fitz_username");
      CookieStorage.delete("fitz_token");
      CookieStorage.delete("fitz_role");
      CookieStorage.delete("fitz_username");
      Toast.show("Logged out successfully", "success");
      window.location.href = "/login.html";
    }
  },
  getSessionInfo() {
    return {
      username: LocalStore.get("fitz_username") || CookieStorage.get("fitz_username"),
      role: CookieStorage.get("fitz_role"),
      token: LocalStore.get("fitz_token"),
      expiresAt: LocalStore.get("fitz_session_expires"),
    };
  },
};

const Admin = {
  async loadOverview() {
    try {
      const authLogs = await API.get("authLogs");
      const payments = await API.get("payments");
      const attendance = await API.get("attendance");
      State.authLogs = authLogs;
      State.payments = payments;
      State.attendance = attendance;
      this.renderStats(authLogs, payments, attendance);
      this.renderRecentAuth(authLogs);
      this.renderPaymentSummary(payments);
    } catch (err) {
      console.error("Error loading admin overview:", err);
      Toast.show("Error loading dashboard data", "error");
    }
  },
  renderStats(authLogs, payments, attendance) {
    const revenue = payments
      .filter((p) => p.status === "paid")
      .reduce((s, p) => s + Number(p.amount), 0);
    const members = [
      ...new Set(
        authLogs.filter((l) => l.type === "register").map((l) => l.name),
      ),
    ].length;
    const presentPct = attendance.length
      ? Math.round(
          (attendance.filter((a) => a.status === "present").length /
            attendance.length) *
            100,
        )
      : 0;
    const grid = document.getElementById("admin-stats-grid");
    if (grid)
      grid.innerHTML = `
      <div class="card"><div class="stat-val" style="color:var(--blue)">${members}</div><div class="stat-lbl">Registered Members</div></div>
      <div class="card"><div class="stat-val" style="color:var(--accent)">Rp ${revenue.toLocaleString("id-ID")}</div><div class="stat-lbl">Total Revenue</div></div>
      <div class="card"><div class="stat-val" style="color:var(--yellow)">${payments.length}</div><div class="stat-lbl">Total Payments</div></div>
      <div class="card"><div class="stat-val" style="color:var(--accent)">${presentPct}%</div><div class="stat-lbl">Attendance Rate</div></div>
    `;
  },
  renderRecentAuth(authLogs) {
    const recent = authLogs.slice(-5).reverse();
    const html = recent
      .map(
        (r) => `<tr>
      <td>${r.name}</td><td><span class="badge b-blue">${r.type}</span></td>
      <td><span class="badge ${r.status === "success" ? "b-green" : "b-red"}">${r.status}</span></td>
    </tr>`,
      )
      .join("");
    const el = document.getElementById("admin-recent-auth");
    if (el) el.innerHTML = `<table><tbody>${html}</tbody></table>`;
  },
  renderPaymentSummary(payments) {
    const paid = (payments || [])
      .filter((p) => p.status === "paid")
      .reduce((s, p) => s + Number(p.amount), 0);
    const unpaid = (payments || [])
      .filter((p) => p.status === "unpaid")
      .reduce((s, p) => s + Number(p.amount), 0);
    const pending = (payments || [])
      .filter((p) => p.status === "pending")
      .reduce((s, p) => s + Number(p.amount), 0);
    const el = document.getElementById("admin-pay-summary");
    if (el) {
      el.innerHTML = `
      <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">
        <span>Paid</span><span style="color:var(--accent);font-weight:600">Rp ${paid.toLocaleString("id-ID")}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">
        <span>Unpaid</span><span style="color:var(--red);font-weight:600">Rp ${unpaid.toLocaleString("id-ID")}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:7px 0">
        <span>Pending</span><span style="color:var(--yellow);font-weight:600">Rp ${pending.toLocaleString("id-ID")}</span>
      </div>
    `;
    }
  },
  async loadAuthLogs() {
    try {
      const rows = await API.get("authLogs");
      State.authLogs = rows;
      this.renderAuthLogs(rows);
    } catch (err) {
      console.error("Error loading auth logs:", err);
      Toast.show("Error loading auth logs", "error");
    }
  },
  renderAuthLogs(rows) {
    const html = rows
      .map(
        (r, i) => `<tr>
      <td>${i + 1}</td><td>${r.name}</td><td><span class="badge b-blue">${r.type}</span></td>
      <td>${r.device}</td><td>${r.timestamp}</td><td><span class="badge ${r.status === "success" ? "b-green" : "b-red"}">${r.status}</span></td>
    </tr>`,
      )
      .join("");
    const el = document.getElementById("auth-logs-body");
    if (el) el.innerHTML = html;
  },
  filterAuth() {
    const q = document.getElementById("search-auth").value.toLowerCase();
    const type = document.getElementById("filter-auth-type").value;
    const status = document.getElementById("filter-auth-status").value;
    const filtered = State.authLogs.filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q)) &&
        (!type || r.type === type) &&
        (!status || r.status === status),
    );
    this.renderAuthLogs(filtered);
  },
  async loadPayments() {
    try {
      const rows = await API.get("payments");
      State.payments = rows;
      this.renderPaymentStats(rows);
      this.renderPayments(rows);
    } catch (err) {
      console.error("Error loading payments:", err);
      Toast.show("Error loading payments", "error");
    }
  },
  renderPaymentStats(rows) {
    const unpaid = rows.filter((p) => p.status === "unpaid").length;
    const pending = rows.filter((p) => p.status === "pending").length;
    const revenue = rows
      .filter((p) => p.status === "paid")
      .reduce((s, p) => s + Number(p.amount), 0);
    const grid = document.getElementById("pay-stats-grid");
    if (grid)
      grid.innerHTML = `
      <div class="card"><div class="stat-val" style="color:var(--blue)">${rows.length}</div><div class="stat-lbl">Transactions</div></div>
      <div class="card"><div class="stat-val" style="color:var(--accent)">Rp ${revenue.toLocaleString("id-ID")}</div><div class="stat-lbl">Revenue (Paid)</div></div>
      <div class="card"><div class="stat-val" style="color:var(--red)">${unpaid}</div><div class="stat-lbl">Unpaid</div></div>
      <div class="card"><div class="stat-val" style="color:var(--yellow)">${pending}</div><div class="stat-lbl">Pending</div></div>
    `;
  },
  renderPayments(rows) {
    const cats = {
      membership: "Membership",
      trainer_rental: "Trainer Rental",
      equipment: "Equipment",
      other: "Other",
    };
    const badge = { paid: "b-green", unpaid: "b-red", pending: "b-yellow" };
    const html = rows
      .map(
        (r, i) => `<tr>
      <td>${i + 1}</td><td>${r.member}</td><td>${cats[r.category] || r.category}</td>
      <td>Rp ${Number(r.amount).toLocaleString("id-ID")}</td><td>${r.date}</td><td>${r.due || "—"}</td>
      <td>${r.method}</td><td><span class="badge ${badge[r.status] || "b-blue"}">${r.status}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="Admin.deletePay(${r.id})">delete</button></td>
    </tr>`,
      )
      .join("");
    const el = document.getElementById("payments-body");
    if (el) el.innerHTML = html;
  },
  filterPay() {
    const q = document.getElementById("search-pay").value.toLowerCase();
    const cat = document.getElementById("filter-pay-category").value;
    const status = document.getElementById("filter-pay-status").value;
    const filtered = State.payments.filter(
      (r) =>
        (!q || r.member.toLowerCase().includes(q)) &&
        (!cat || r.category === cat) &&
        (!status || r.status === status),
    );
    this.renderPayments(filtered);
  },
  async savePay() {
    const amount = parseInt(document.getElementById("pay-amount").value) || 0;
    const due = document.getElementById("pay-due").value;

    // Server-side aligned Validation requirements
    if (amount < 175000) {
      Toast.show("Minimum payment amount is Rp 175.000", "error");
      return;
    }
    if (!due) {
      Toast.show("Due date must be entered", "error");
      return;
    }

    const data = {
      member: document.getElementById("pay-name").value.trim(),
      category: document.getElementById("pay-category").value,
      amount: amount,
      status: document.getElementById("pay-status-sel").value,
      method: document.getElementById("pay-method").value,
      due: due,
      date: new Date().toISOString().slice(0, 10),
    };

    if (!data.member) return Toast.show("Member name is required", "error");

    await API.post("payments", data);
    Toast.show("Payment saved ✓", "success");
    UI.hide("add-payment-form");
    this.loadPayments();
    document.getElementById("add-payment-form").reset?.();
  },
  async deletePay(id) {
    if (!confirm(`Delete payment #${id}?`)) return;
    await API.delete("payments", id);
    Toast.show("Payment deleted", "success");
    this.loadPayments();
  },
  async loadAttendance() {
    try {
      const rows = await API.get("attendance");
      State.attendance = rows;
      this.renderAttendanceStats(rows);
      this.renderAttendance(rows);
    } catch (err) {
      console.error("Error loading attendance:", err);
      Toast.show("Error loading attendance", "error");
    }
  },
  renderAttendanceStats(rows) {
    const present = rows.filter((r) => r.status === "present").length;
    const absent = rows.filter((r) => r.status === "absent").length;
    const grid = document.getElementById("att-stats-grid");
    if (grid)
      grid.innerHTML = `
      <div class="card"><div class="stat-val" style="color:var(--blue)">${rows.length}</div><div class="stat-lbl">Total Records</div></div>
      <div class="card"><div class="stat-val" style="color:var(--accent)">${present}</div><div class="stat-lbl">Present</div></div>
      <div class="card"><div class="stat-val" style="color:var(--red)">${absent}</div><div class="stat-lbl">Absent</div></div>
    `;
  },
  renderAttendance(rows) {
    const badge = { present: "b-green", absent: "b-red" };
    const html = rows
      .map(
        (r, i) => `<tr>
      <td>${i + 1}</td><td>${r.member}</td><td>${r.date}</td>
      <td>${r.checkIn || "—"}</td><td>${r.checkOut || "—"}</td>
      <td>${r.activity}</td><td><span class="badge ${badge[r.status] || "b-blue"}">${r.status}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="Admin.deleteAtt(${r.id})">delete</button></td>
    </tr>`,
      )
      .join("");
    const el = document.getElementById("attendance-body");
    if (el) el.innerHTML = html;
  },
  filterAtt() {
    const q = document.getElementById("search-att").value.toLowerCase();
    const status = document.getElementById("filter-att-status").value;
    const filtered = State.attendance.filter(
      (r) =>
        (!q || r.member.toLowerCase().includes(q)) &&
        (!status || r.status === status),
    );
    this.renderAttendance(filtered);
  },
  async saveAtt() {
    const data = {
      member: document.getElementById("att-name").value.trim(),
      activity: document.getElementById("att-activity").value,
      checkIn: document.getElementById("att-in").value,
      checkOut: document.getElementById("att-out").value,
      status: document.getElementById("att-status-sel").value,
      date: new Date().toISOString().slice(0, 10),
    };
    if (!data.member) return Toast.show("Member name is required", "error");

    await API.post("attendance", data);
    Toast.show("Attendance marked ✓", "success");
    UI.hide("mark-att-form");
    this.loadAttendance();
  },
  async deleteAtt(id) {
    if (!confirm(`Delete attendance #${id}?`)) return;
    await API.delete("attendance", id);
    Toast.show("Record deleted", "success");
    this.loadAttendance();
  },
  exportCSV(table, filename) {
    const data = State[table] || [];
    if (!data.length) return Toast.show("No data to export", "error");
    const keys = Object.keys(data[0]);
    const csv = [
      keys.join(","),
      ...data.map((r) => keys.map((k) => `"${r[k] ?? ""}"`).join(",")),
    ].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    window.URL.revokeObjectURL(url);
  },
};

const Trainer = {
  async loadClients() {
    try {
      const clients = await API.get("clients");
      State.clients = clients;
      this.renderClients(clients);
    } catch (err) {
      console.error("Error loading clients:", err);
      Toast.show("Error loading clients", "error");
    }
  },
  renderClients(clients) {
    const statBadge = { active: "b-green", inactive: "b-red" };
    const html = clients
      .map(
        (c) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between">
          <div><strong>${c.name}</strong><span class="badge b-blue" style="margin-left:8px">${c.program}</span><span class="badge ${statBadge[c.status]}" style="margin-left:4px">${c.status}</span></div>
          <span class="hint">${c.sessions} sessions</span>
        </div>
        <p style="margin-top:8px;color:var(--muted);font-size:12px">🎯 ${c.goal}</p>
      </div>
    `,
      )
      .join("");
    const el = document.getElementById("workout-plans-list");
    if (el) el.innerHTML = html;
  },
  async loadExercises() {
    try {
      const exercises = await API.get("exercises");
      State.exercises = exercises;
      this.renderExerciseStats(exercises);
      this.renderExercises(exercises);
    } catch (err) {
      console.error("Error loading exercises:", err);
      Toast.show("Error loading exercises", "error");
    }
  },
  renderExerciseStats(exercises) {
    const avgW = exercises.length
      ? (
          exercises.reduce((s, e) => s + Number(e.weight), 0) / exercises.length
        ).toFixed(1)
      : 0;
    const grid = document.getElementById("exercise-stats-grid");
    if (grid)
      grid.innerHTML = `
      <div class="card"><div class="stat-val" style="color:var(--blue)">${exercises.length}</div><div class="stat-lbl">Total Sessions</div></div>
      <div class="card"><div class="stat-val" style="color:var(--accent)">${avgW}</div><div class="stat-lbl">Avg Weight (kg)</div></div>
      <div class="card"><div class="stat-val" style="color:var(--yellow)">${exercises.reduce((s, e) => s + Number(e.sets), 0)}</div><div class="stat-lbl">Total Sets</div></div>
      <div class="card"><div class="stat-val" style="color:var(--blue)">${[...new Set(exercises.map((e) => e.member))].length}</div><div class="stat-lbl">Members</div></div>
    `;
  },
  renderExercises(exercises) {
    const html = exercises
      .map(
        (r) => `<tr>
      <td>${r.member}</td><td>${r.exercise}</td><td>${r.sets}</td>
      <td>${r.reps}</td><td>${r.weight}</td><td>${r.date}</td><td style="color:var(--muted)">${r.notes || "—"}</td>
    </tr>`,
      )
      .join("");
    const el = document.getElementById("exercise-log-body");
    if (el) el.innerHTML = html;
  },
  async loadEarnings() {
    try {
      const earnings = await API.get("earnings");
      State.earnings = earnings;
      this.renderEarningsStats(earnings);
      this.renderEarnings(earnings);
    } catch (err) {
      console.error("Error loading earnings:", err);
      Toast.show("Error loading earnings", "error");
    }
  },
  renderEarningsStats(earnings) {
    const paid = earnings
      .filter((e) => e.status === "paid")
      .reduce((s, e) => s + Number(e.amount), 0);
    const avg = earnings.length ? Math.round(paid / earnings.length) : 0;
    const grid = document.getElementById("trainer-earnings-grid");
    if (grid)
      grid.innerHTML = `
      <div class="card"><div class="stat-val" style="color:var(--blue)">${earnings.length}</div><div class="stat-lbl">Sessions</div></div>
      <div class="card"><div class="stat-val" style="color:var(--accent)">Rp ${paid.toLocaleString("id-ID")}</div><div class="stat-lbl">Total Earned</div></div>
      <div class="card"><div class="stat-val" style="color:var(--yellow)">${earnings.filter((e) => e.status === "pending").length}</div><div class="stat-lbl">Pending</div></div>
      <div class="card"><div class="stat-val" style="color:var(--blue)">Rp ${avg.toLocaleString("id-ID")}</div><div class="stat-lbl">Avg/Session</div></div>
    `;
  },
  renderEarnings(earnings) {
    const html = earnings
      .map(
        (r) => `<tr>
      <td>${r.client}</td><td>${r.date}</td><td>${r.duration}</td>
      <td>Rp ${Number(r.amount).toLocaleString("id-ID")}</td><td><span class="badge ${r.status === "paid" ? "b-green" : "b-yellow"}">${r.status}</span></td>
    </tr>`,
      )
      .join("");
    const el = document.getElementById("trainer-earnings-body");
    if (el) el.innerHTML = html;
  },
  loadMeals() {
    const plans = [
      {
        client: "Budi Santoso",
        plan: "High Protein",
        cal: 2800,
        meals: [
          "Breakfast: Oats + Eggs + Protein Shake",
          "Lunch: Grilled Chicken Breast + Brown Rice",
          "Snack: Greek Yogurt + Nuts",
          "Dinner: Salmon + Steamed Vegetables",
        ],
      },
      {
        client: "Dewi Kusuma",
        plan: "Low Carb / Fat Loss",
        cal: 1800,
        meals: [
          "Breakfast: Scrambled Eggs + Avocado",
          "Lunch: Mixed Salad + Tuna",
          "Snack: Almonds",
          "Dinner: Grilled Chicken + Broccoli",
        ],
      },
      {
        client: "Eko Prasetyo",
        plan: "Balanced Endurance",
        cal: 2200,
        meals: [
          "Breakfast: Banana + Yogurt + Granola",
          "Lunch: White Rice + Tempeh + Spinach",
          "Snack: Fruit Smoothie",
          "Dinner: Tofu Stir-fry + Noodles",
        ],
      },
    ];
    const html = plans
      .map(
        (p) => `
      <div class="card">
        <div style="display:flex;justify-content:space-between;margin-bottom:10px">
          <strong>${p.client}</strong><div><span class="badge b-blue">${p.plan}</span><span class="hint" style="margin-left:8px">${p.cal} kcal/day</span></div>
        </div>
        ${p.meals.map((m) => `<div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:13px">🍽️ ${m}</div>`).join("")}
      </div>
    `,
      )
      .join("");
    const el = document.getElementById("meal-plans-list");
    if (el) el.innerHTML = html;
  },
};

const App = {
  async init() {
    await IndexedDBStore.init().catch((err) =>
      console.warn("IndexedDB skip:", err),
    );

    const role = Auth.check();
    const path = window.location.pathname;
    State.role = role;

    // Routing Logic for MPA
    if (!role && !path.includes("login.html") && path !== "/") {
      window.location.href = "/login.html";
      return;
    }

    if (role) {
      if (path.includes("login.html") || path === "/") {
        window.location.href = `/${role}.html`;
        return;
      }

      RealTime.init();

      if (role === "admin" && path.includes("admin.html")) {
        await Admin.loadOverview();
        Router.tab(LocalStore.get("fitz_last_section", "overview"));
      } else if (role === "trainer" && path.includes("trainer.html")) {
        await Trainer.loadClients();
        Trainer.loadMeals();
        Router.tab(LocalStore.get("fitz_last_section", "workouts"));
      }

      // Close menu when clicking outside on mobile
      document.addEventListener("click", (e) => UI.closeMenuOutside(e));
    }
  },
  login() {
    return Auth.login();
  },
  logout() {
    return Auth.logout();
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
