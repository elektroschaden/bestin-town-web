/* Supabase-backed cloud adapter for Best in Town.
 *
 * Drop-in alternative to local-adapter.js: exposes the SAME shape so the
 * existing UI code needs minimal changes —
 *   db.collection(name).doc(id).get()/set()/update()/delete()
 *   db.collection(name).onSnapshot(next, error)
 *   assets.upload(blob)/get(id)/delete(id)
 *   user.id() / user.isOwner() / user.can(action)
 *   exportBackup() / importBackup(backup, confirmReplace)
 *
 * Requires the Supabase JS client to be loaded globally before this file,
 * e.g. in index.html:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
 *   <script src="supabase-adapter.js"></script>
 * Then call BestCloud.open({ url, anonKey }) instead of BestLocal.open().
 *
 * Auth model implemented here (per the approved design):
 *  - signInAnonymously() automatically on first open() if there's no session.
 *  - joinCommunity(email) starts the anonymous→email upgrade via
 *    supabase.auth.updateUser({ email }) which sends a confirmation/magic
 *    link; completing it (confirmJoinCommunity, called from the link landing)
 *    preserves auth.uid() and all existing rows owned by that id — it is an
 *    identity upgrade, never a new account.
 *  - Role (visitor/pate/supervisor) is read from public.profiles, NEVER
 *    trusted purely client-side: every privileged write is re-checked by
 *    Postgres RLS regardless of what user.can() says in the UI.
 */
(() => {
'use strict';

const COLLECTIONS = {
  places: { table: 'places', idCol: 'id' },
  votes: { table: 'votes', idCol: 'id' },
  paten: { table: 'paten', idCol: 'id' },
  trusted: { table: 'trusted', idCol: 'user_id' },
  // Pre-cloud-cutover comments/votes have no real auth user_id (only an
  // opaque legacy_user_id, see supabase/migrations/0001_schema.sql and
  // data_migration/export_to_sql.py) — they are "trusted" through this
  // SEPARATE table, keyed by that legacy id, not the real `trusted` table.
  trustedLegacy: { table: 'trusted_legacy_unmapped', idCol: 'legacy_user_id' },
  suggestions: { table: 'suggestions', idCol: 'user_id' },
  duels: { table: 'duels', idCol: 'id' },
  duelvotes: { table: 'duelvotes', idCol: 'user_id' },
};
const names = Object.keys(COLLECTIONS);
const fail = (m) => { throw Error(m); };

// Postgres folds UNQUOTED identifiers to lowercase — photoX/cityName/needsReview
// in supabase/migrations/0001_schema.sql are unquoted, so the REAL column names
// are photox/cityname/needsreview, not camelCase. PostgREST matches column
// names exactly, so sending the camelCase JS key silently fails to find the
// column ("Could not find the 'photoX' column of 'paten'") on write, and on
// read the value just lands under the lowercase key, invisible to app code
// that expects camelCase (photo crop position/zoom silently wrong).
const CASE_MAP = {
  places: { photoX: 'photox', photoY: 'photoy', photoZ: 'photoz', cityName: 'cityname', needsReview: 'needsreview', photoBy: 'photoby', createdBy: 'created_by', confirmedAt: 'confirmed_at', confirmCount: 'confirm_count' },
  paten: { photoX: 'photox', photoY: 'photoy', photoZ: 'photoz', createdBy: 'created_by' },
  // votes.placeId/userId are real snake_case FK columns (see 0001_schema.sql),
  // distinct from the composite "placeId__uid" primary key written via idCol
  // below — without this mapping every vote silently failed to save
  // ("Could not find the 'placeId' column of 'votes'"), masked by a generic
  // catch-all error message in index.html's saveVote().
  votes: { placeId: 'place_id', userId: 'user_id' },
};
const toDbKey = (name, key) => (CASE_MAP[name] && CASE_MAP[name][key]) || key;
const fromDbKey = (name, key) => {
  const map = CASE_MAP[name];
  if (!map) return key;
  const hit = Object.entries(map).find(([, v]) => v === key);
  return hit ? hit[0] : key;
};

// Map between the app's camelCase doc shape and the DB's snake_case columns
// for the two tables that need it (places/paten legacy mirror + created_by).
// createdAt/updatedAt are ALWAYS dropped on write: every table manages these
// itself (column default now() + a touch_updated_at() trigger on UPDATE, see
// supabase/migrations/0001_schema.sql) — sending the client's own
// Date.now() number for them errors ("could not find the updateAt column":
// neither a real column name nor a valid timestamptz value).
const stripClientTimestamps = (data) => {
  const { createdAt, updatedAt, ...rest } = data;
  return rest;
};
const toDbRow = (name, data) => {
  const row = {};
  for (const [k, v] of Object.entries(stripClientTimestamps(data))) row[toDbKey(name, k)] = v;
  return row;
};
const toRow = (name, id, data) => {
  const row = toDbRow(name, data);
  if (COLLECTIONS[name].idCol === 'id') row.id = id;
  else row[COLLECTIONS[name].idCol] = id;
  return row;
};
const fromRow = (name, row) => {
  const { id, user_id, place_id, created_by, created_at, updated_at, legacy_user_id, ...rest } = row;
  const data = {};
  for (const [k, v] of Object.entries(rest)) data[fromDbKey(name, k)] = v;
  if (place_id !== undefined) data.placeId = place_id;
  if (user_id !== undefined && COLLECTIONS[name].idCol !== 'user_id') data.userId = user_id;
  if (created_by !== undefined && created_by !== null) data.createdBy = created_by;
  if (legacy_user_id !== undefined && COLLECTIONS[name].idCol !== 'legacy_user_id') data.legacyUserId = legacy_user_id;
  return data;
};
const docIdOf = (name, row) => row[COLLECTIONS[name].idCol];

async function open({ url, anonKey, client } = {}) {
  if (!client && (!url || !anonKey)) fail('Supabase-URL und anon-Key erforderlich');
  const supabase = client || window.supabase.createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // ---- auth bootstrap: anonymous session on first open, zero friction ----
  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) fail('Anmeldung fehlgeschlagen: ' + error.message);
    session = data.session;
  }

  let profileCache = null;
  async function profile() {
    if (profileCache) return profileCache;
    // Explicit .eq('id', uid) is required: the supervisor's own RLS select
    // policy also makes EVERY other profile row visible to them (so they can
    // administer roles), so an unfiltered select().single() returns multiple
    // rows and throws for a supervisor specifically — filtering to their own
    // row is what actually scopes this call to "my own profile".
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) fail('Keine aktive Sitzung');
    const { data, error } = await supabase.from('profiles').select('role,display_name').eq('id', authUser.id).single();
    if (error) fail('Profil konnte nicht geladen werden: ' + error.message);
    profileCache = data;
    return data;
  }
  supabase.auth.onAuthStateChange(() => { profileCache = null; });

  const userApi = {
    id: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    isOwner: async () => (await profile()).role === 'supervisor',
    // Real role straight from public.profiles (RLS-governed), never guessed
    // client-side. UI uses this to pick Besucher/Pate/Supervisor presentation;
    // every privileged action is still re-checked by Postgres RLS regardless.
    role: async () => (await profile()).role,
    isAnonymous: async () => (await supabase.auth.getUser()).data.user?.is_anonymous ?? true,
    // role-aware capability map; UI convenience only — RLS is the real gate.
    can: async (action) => {
      const role = (await profile()).role;
      const caps = {
        'vote.cast': ['visitor', 'pate', 'supervisor'],
        'suggestion.create': ['visitor', 'pate', 'supervisor'],
        'place.create': ['pate', 'supervisor'],
        'place.editOwn': ['pate', 'supervisor'],
        'place.delete': ['supervisor'],
        'paten.editOwn': ['pate', 'supervisor'],
        'role.promote': ['supervisor'],
        'suggestion.review': ['pate', 'supervisor'],
      };
      return (caps[action] || []).includes(role);
    },
    // "Der Community beitreten?" — upgrade anonymous session to email identity.
    // Preserves auth.uid() and every row already owned by it.
    joinCommunity: async (email) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) fail('Keine aktive Sitzung');
      if (!user.is_anonymous) return { alreadyLinked: true };
      const { error } = await supabase.auth.updateUser({ email });
      if (error) fail('Beitritt fehlgeschlagen: ' + error.message);
      return { alreadyLinked: false, pendingVerification: true };
    },
    // Completes the anonymous→email upgrade using the 6-digit code from the
    // "Confirm email change" template (type 'email_change'), NOT a password.
    // Chosen over relying solely on the magic-link click because this
    // Supabase project's outbound mail showed flaky link deliverability
    // during setup; the OTP code is sent in the same email as a fallback
    // and verified here independently of whether the link itself works.
    confirmJoinCommunity: async (email, token) => {
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email_change' });
      if (error) fail('Bestätigung fehlgeschlagen: ' + error.message);
      profileCache = null;
      return { user: data.user };
    },
    // "Ich habe schon ein Konto" — sign in to an EXISTING email-linked account
    // (e.g. the supervisor account) via a one-time code, no password needed.
    // Deliberately separate from joinCommunity(): that call upgrades THIS
    // anonymous session's identity and fails outright if the email already
    // belongs to another account (exactly the supervisor's case) — this call
    // instead signs OUT of the anonymous session and signs IN as the
    // existing account, replacing the session entirely.
    signInExisting: async (email) => {
      const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (error) fail('Anmeldung fehlgeschlagen: ' + error.message);
      return { pendingVerification: true };
    },
    confirmSignInExisting: async (email, token) => {
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
      if (error) fail('Bestätigung fehlgeschlagen: ' + error.message);
      profileCache = null;
      return { user: data.user };
    },
    // Abmelden: zurück in eine frische anonyme Sitzung. Ohne das neue
    // Anonymous-Login hätte die App danach gar keine Identität — Stimmen und
    // Vorschläge brauchen eine uid. Die bisherige Historie bleibt am alten
    // Konto und ist nach erneutem Anmelden wieder da.
    signOut: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) fail('Abmelden fehlgeschlagen: ' + error.message);
      const { error: again } = await supabase.auth.signInAnonymously();
      if (again) fail('Neue Sitzung fehlgeschlagen: ' + again.message);
      profileCache = null;
    },
  };

  // ---- generic collection/doc wrapper ----
  function collection(name) {
    if (!names.includes(name)) fail('Unbekannte Sammlung');
    const { table, idCol } = COLLECTIONS[name];
    const doc = (id) => ({
      id,
      get: async () => {
        const { data, error } = await supabase.from(table).select('*').eq(idCol, id).maybeSingle();
        if (error) fail(error.message);
        return { id, exists: !!data, data: () => (data ? fromRow(name, data) : undefined) };
      },
      set: async (data) => {
        const row = toRow(name, id, data);
        const { error } = await supabase.from(table).upsert(row, { onConflict: idCol });
        if (error) fail(error.message);
      },
      update: async (data) => {
        const row = toDbRow(name, data);
        const { error } = await supabase.from(table).update(row).eq(idCol, id);
        if (error) fail(error.message);
      },
      delete: async () => {
        const { error } = await supabase.from(table).delete().eq(idCol, id);
        if (error) fail(error.message);
      },
    });
    return {
      doc,
      get: async () => {
        const { data, error } = await supabase.from(table).select('*');
        if (error) fail(error.message);
        return {
          docs: (data || []).map((row) => ({ id: docIdOf(name, row), exists: true, data: () => fromRow(name, row) })),
          metadata: { fromCache: false },
        };
      },
      add: async (data) => {
        const id = crypto.randomUUID().replaceAll('-', '');
        await doc(id).set(data);
        return doc(id);
      },
      // Realtime subscription standing in for onSnapshot: pushes an initial
      // snapshot, then keeps a local copy of every row in this table.
      //
      // Bei wachsender Tabellengröße ist das Nachladen der KOMPLETTEN Tabelle
      // bei jeder einzelnen Änderung (eine Stimme, eine Bearbeitung) der
      // teuerste Teil der App — Kosten wachsen mit der Gesamtgröße der
      // Tabelle, nicht mit der Größe der Änderung. Deshalb holt ein
      // Änderungsereignis nur noch die betroffene(n) Zeile(n) per id nach,
      // nie die ganze Tabelle.
      //
      // Sicherheit bleibt unverändert: die id kommt zwar aus dem
      // Echtzeit-Ereignis, aber ihr INHALT wird NIE direkt übernommen — jede
      // Zeile wird anschließend ganz normal per select().eq(idCol, …) neu
      // geholt, also genauso RLS-geprüft wie der bisherige volle Abruf. Eine
      // id, die laut RLS nicht (mehr) sichtbar ist, liefert einfach keine
      // Zeile und wird lokal entfernt — exakt das Verhalten von vorher, nur
      // auf die geänderten Zeilen beschränkt statt auf die ganze Tabelle.
      onSnapshot: (next, error) => {
        let closed = false;
        let lastSerialized = null;
        let rowsById = new Map();
        let initialized = false;
        const emit = () => {
          const rows = [...rowsById.values()];
          // The REAL fix for render-jitter: skip calling next()/render()
          // entirely when the confirmed server data is byte-identical to
          // what's already shown — e.g. the realtime echo of our OWN
          // optimistic write, or any write that round-trips unchanged.
          const serialized = JSON.stringify(rows.map((r) => [docIdOf(name, r), r]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
          if (serialized === lastSerialized) return;
          lastSerialized = serialized;
          if (!closed) next({
            docs: rows.map((row) => ({ id: docIdOf(name, row), exists: true, data: () => fromRow(name, row) })),
            metadata: { fromCache: false },
          });
        };
        const fullLoad = async () => {
          try {
            const { data, error: e } = await supabase.from(table).select('*');
            if (e) throw e;
            rowsById = new Map((data || []).map((row) => [docIdOf(name, row), row]));
            initialized = true;
            emit();
          } catch (e) { if (!closed) error?.(e); }
        };
        // Realtime fires once PER ROW changed — eine Mehrfachänderung (z. B.
        // Umsortieren mehrerer Orte) kann mehrere Ereignisse hintereinander
        // auslösen; ein kurzer Debounce sammelt deren ids und holt sie am
        // Ende in EINER Abfrage statt einer pro Zeile.
        let pendingIds = new Set();
        let debounceTimer = null;
        const flushPending = async () => {
          if (!initialized || !pendingIds.size) return;
          const ids = [...pendingIds]; pendingIds = new Set();
          try {
            const { data, error: e } = await supabase.from(table).select('*').in(idCol, ids);
            if (e) throw e;
            const found = new Set();
            for (const row of data || []) { const id = docIdOf(name, row); rowsById.set(id, row); found.add(id); }
            // Nicht gefunden = gelöscht ODER durch RLS nicht mehr sichtbar —
            // in beiden Fällen gehört die Zeile lokal entfernt.
            for (const id of ids) if (!found.has(id)) rowsById.delete(id);
            emit();
          } catch (e) { if (!closed) error?.(e); }
        };
        const scheduleFlush = () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(flushPending, 200);
        };
        const onChange = (payload) => {
          const row = (payload.new && Object.keys(payload.new).length) ? payload.new : payload.old;
          const id = row && row[idCol];
          // Unbekannte id (sollte nicht vorkommen) ist das einzige Sicherheitsnetz:
          // dann lieber einmal die ganze Tabelle neu laden als etwas verpassen.
          if (id === undefined) { fullLoad(); return; }
          pendingIds.add(id);
          scheduleFlush();
        };
        const channel = supabase.channel('realtime:' + table)
          .on('postgres_changes', { event: '*', schema: 'public', table }, onChange)
          .subscribe();
        fullLoad();
        return () => { closed = true; if (debounceTimer) clearTimeout(debounceTimer); supabase.removeChannel(channel); };
      },
    };
  }

  // ---- assets: Supabase Storage bucket 'place-photos' ----
  const BUCKET = 'place-photos';
  const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const extOf = (type) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[type] || 'bin');
  const validateImage = async (blob) => {
    if (!(blob instanceof Blob) || !imageTypes.has(blob.type)) fail('Nur JPG, PNG, WebP oder GIF erlaubt.');
    if (!blob.size || blob.size > 20 * 1024 * 1024) fail('Bild ist leer oder größer als 20 MB.');
    const bmp = await createImageBitmap(blob);
    bmp.close();
  };
  const urlCache = new Map();
  const assets = {
    // Was previously an in-memory cache only populated by upload() in THIS
    // session — so a photo uploaded earlier (e.g. by the Mac-LAN→Supabase
    // migration script) never appeared, because nothing had ever called
    // upload() for it in the browser. getPublicUrl() is a pure client-side
    // URL construction (no network call), so compute it directly every time.
    url: (id) => {
      if (!id) return '';
      if (!urlCache.has(id)) {
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(id);
        urlCache.set(id, data.publicUrl);
      }
      return urlCache.get(id);
    },
    upload: async (blob, opts = {}) => {
      if (opts.type && opts.type !== blob.type) blob = new Blob([blob], { type: opts.type });
      await validateImage(blob);
      const id = crypto.randomUUID().replaceAll('-', '');
      const path = `${id}.${extOf(blob.type)}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type });
      if (upErr) fail('Bild-Upload fehlgeschlagen: ' + upErr.message);
      const { data: { user } } = await supabase.auth.getUser();
      const { error: metaErr } = await supabase.from('assets_meta').insert({
        id: path, content_type: blob.type, size_bytes: blob.size, created_by: user?.id ?? null,
      });
      if (metaErr) { await supabase.storage.from(BUCKET).remove([path]); fail('Bild-Metadaten fehlgeschlagen: ' + metaErr.message); }
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      urlCache.set(path, pub.publicUrl);
      return { id: path };
    },
    get: async (id) => {
      const { data, error } = await supabase.storage.from(BUCKET).download(id);
      if (error) return null;
      return data;
    },
    delete: async (id) => {
      await supabase.storage.from(BUCKET).remove([id]);
      await supabase.from('assets_meta').delete().eq('id', id);
      urlCache.delete(id);
    },
  };

  // ---- backup export/import, compatible with the local-adapter format ----
  async function exportBackup() {
    const collections = {};
    for (const name of names) {
      const { data, error } = await supabase.from(COLLECTIONS[name].table).select('*');
      if (error) fail(error.message);
      collections[name] = Object.fromEntries((data || []).map((row) => [docIdOf(name, row), fromRow(name, row)]));
    }
    const { data: metaRows } = await supabase.from('assets_meta').select('*');
    const assetList = [];
    for (const m of metaRows || []) {
      const blob = await assets.get(m.id);
      if (!blob) continue;
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(',')[1]);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      assetList.push({ id: m.id, type: m.content_type, base64 });
    }
    return { format: 'best-in-town-local', version: 1, exportedAt: new Date().toISOString(), collections, assets: assetList };
  }

  async function validateBackup(backup) {
    if (!backup || backup.format !== 'best-in-town-local' || backup.version !== 1) fail('Kein unterstütztes Best-in-Town-Backup (Version 1).');
    return backup;
  }

  // Import writes row-by-row through the normal RLS-checked client calls —
  // it does NOT truncate tables (no service_role here), so it only ever adds
  // or overwrites rows the current session is authorized to touch. Full
  // production migration of pre-existing Mac-LAN data is done via the
  // separate SQL script in supabase/data_migration/ (run once, by the user,
  // in the SQL Editor, which bypasses RLS the same way any admin tool would).
  async function importBackup(backup, confirmReplace) {
    await validateBackup(backup);
    if (typeof confirmReplace !== 'function') fail('Bestätigung zum Ersetzen erforderlich');
    if ((await confirmReplace()) !== true) return false;
    for (const name of names) {
      for (const [id, data] of Object.entries(backup.collections[name] || {})) {
        await collection(name).doc(id).set(data);
      }
    }
    return true;
  }

  return {
    assets, exportBackup, importBackup, validateBackup,
    db: { collection },
    user: userApi,
    supabase, // escape hatch for app code that needs raw client (e.g. magic-link callback handling)
    close: () => { /* no persistent local resources to release */ },
  };
}

window.BestCloud = { open };
})();
