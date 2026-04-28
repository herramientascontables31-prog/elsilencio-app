// ============================================================
//  GANADERÍA EL SILENCIO — PWA App v3
//  Offline-first · IndexedDB + localStorage backup · Google Sheets sync
// ============================================================

const App = (() => {
  const DB_NAME = 'ElSilencioDB';
  const DB_VERSION = 1;
  const STORE = 'records';
  const CONFIG_KEY = 'elsilencio_config';
  const BACKUP_KEY = 'elsilencio_backup';
  const DEFAULT_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsweijU5TzsdDzK18JT-pduRqjTwTLgJkuXW_Ess0Et89OzNqzVBehQHdTjnwU_BZzzg/exec';
  const DEFAULT_ANIMALS = ['A001','A002','A003','A004','A006','A007','A008','A010','A011','A012','A014','A015'];

  const LAST_PESAJE = {
    'A001':{peso:322,fecha:'2025-07-10'},'A002':{peso:278,fecha:'2025-05-15'},
    'A003':{peso:331,fecha:'2025-07-10'},'A004':{peso:271,fecha:'2025-05-15'},
    'A006':{peso:263,fecha:'2025-06-01'},'A007':{peso:303,fecha:'2025-06-15'},
    'A008':{peso:283,fecha:'2025-07-01'},'A010':{peso:287,fecha:'2025-07-15'},
    'A011':{peso:255,fecha:'2025-06-01'},'A012':{peso:238,fecha:'2025-06-01'},
    'A014':{peso:238,fecha:'2025-07-01'},'A015':{peso:250,fecha:'2025-07-01'}
  };

  // Default offline para el primer arranque. Se reemplazan al primer sync con Sheet.
  const DEFAULT_CUADRAS_CABALLOS = [
    {cuadra:1,area:2044,zona:'Zona 1',pasto:'70% pasto amargo y cortadera, 30% grama'},
    {cuadra:2,area:1323,zona:'Zona 1',pasto:'40% cortadera, 60% pasto'},
    {cuadra:3,area:1078,zona:'Zona 1',pasto:'10% pasto amargo, 100% grama'},
    {cuadra:4,area:1325,zona:'Zona 1',pasto:'40% estrella, 60% grama'},
    {cuadra:5,area:1099,zona:'Zona 1',pasto:'100% grama'},
    {cuadra:6,area:1637,zona:'Zona 1',pasto:'100% grama'},
    {cuadra:7,area:2555,zona:'Zona 1',pasto:'100% grama'},
    {cuadra:8,area:2051,zona:'Zona 1',pasto:''},
    {cuadra:9,area:2086,zona:'Zona 1',pasto:''},
    {cuadra:10,area:2535,zona:'Zona 1',pasto:''},
    {cuadra:11,area:2307,zona:'Zona 1',pasto:''},
    {cuadra:12,area:2385,zona:'Zona 1',pasto:''},
    {cuadra:13,area:1876,zona:'Zona 1',pasto:''},
    {cuadra:14,area:1216,zona:'Zona 1',pasto:''},
    {cuadra:15,area:1062,zona:'Zona 1',pasto:''}
  ];
  const DEFAULT_CUADRAS_GANADO = [
    {cuadra:11,area:0.4524,zona:'Zona 1',pasto:'20% Cortadera y escoba, 80% Climacuna'},
    {cuadra:12,area:0.4233,zona:'Zona 1',pasto:'30% cortadera, 70% Climacuna y Grama'}
  ];

  // Estado mutable: cuadras vivas (cargadas desde Sheet o desde cache).
  // Indexado por número de cuadra para lookup rápido en savePradera/onCuadraChange.
  let CUADRAS_CABALLOS = {};
  let CUADRAS_GANADO = {};

  let db = null;
  let editingRecord = null; // record being edited

  // ==================== INIT ====================
  async function init() {
    await openDB();
    const cfg = getConfig();
    let changed = false;
    if (!cfg.scriptUrl) { cfg.scriptUrl = DEFAULT_SCRIPT_URL; changed = true; }
    if (!cfg.animales || cfg.animales.length === 0) { cfg.animales = DEFAULT_ANIMALS; changed = true; }
    if (!cfg.cuadrasCaballos || cfg.cuadrasCaballos.length === 0) { cfg.cuadrasCaballos = DEFAULT_CUADRAS_CABALLOS; changed = true; }
    if (!cfg.cuadrasGanado || cfg.cuadrasGanado.length === 0) { cfg.cuadrasGanado = DEFAULT_CUADRAS_GANADO; changed = true; }
    if (changed) localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));

    applyCuadras(cfg.cuadrasCaballos, cfg.cuadrasGanado);

    // Mostrar pantalla de PIN si hay PIN configurado
    if (cfg.pin) {
      showPinScreen();
      return; // No inicializar hasta que desbloquee
    }

    finishInit();
  }

  function finishInit() {
    loadConfig();
    setDefaultDates();
    updateSyncBadge();
    updateConnectionStatus();
    registerSW();
    setupAnimalAutoFill();

    // Restaurar backup si IndexedDB está vacío
    restoreFromBackup();

    // Sync automático cuando vuelve la conexión
    window.addEventListener('online', () => {
      updateConnectionStatus();
      toast('Conexión detectada. Sincronizando...', 'info');
      syncNow();
    });
    window.addEventListener('offline', () => {
      updateConnectionStatus();
      toast('Sin conexión. Los datos se guardan localmente.', 'info');
    });

    // Sync cuando la app vuelve al primer plano (ej: vaquero abre la app de nuevo)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        updateConnectionStatus();
        getPendingRecords().then(p => { if (p.length > 0) syncNow(); });
      }
    });

    // Sync periódico cada 2 min mientras la app esté abierta
    startPeriodicSync();

    // Intentar sync inicial
    tryAutoSync();

    // Refrescar cuadras desde Sheet aunque no haya pendientes
    if (navigator.onLine) {
      const cfg = getConfig();
      if (cfg.scriptUrl) loadCuadrasList(cfg.scriptUrl);
    }
  }

  // ==================== PIN LOCK ====================
  function showPinScreen() {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-pin').classList.add('active');
    const inp = document.getElementById('pin-input');
    inp.value = '';
    inp.focus();
  }

  function checkPin() {
    const entered = document.getElementById('pin-input').value.trim();
    const cfg = getConfig();
    if (entered === cfg.pin) {
      document.getElementById('screen-pin').classList.remove('active');
      document.getElementById('pin-error').style.display = 'none';
      document.getElementById('screen-home').classList.add('active');
      finishInit();
    } else {
      document.getElementById('pin-error').style.display = 'block';
      document.getElementById('pin-input').value = '';
      document.getElementById('pin-input').focus();
    }
  }

  // ==================== CONNECTION STATUS ====================
  function updateConnectionStatus() {
    const dot = document.getElementById('connection-dot');
    if (!dot) return;
    if (navigator.onLine) {
      dot.className = 'connection-dot online';
      dot.title = 'Con internet';
    } else {
      dot.className = 'connection-dot offline';
      dot.title = 'Sin internet';
    }
  }

  // ==================== INDEXEDDB ====================
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const store = d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('synced', 'synced', { unique: false });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(); };
      req.onerror = (e) => reject(e);
    });
  }

  function addRecord(record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      record.synced = false;
      record.timestamp = new Date().toISOString();
      tx.objectStore(STORE).add(record);
      tx.oncomplete = () => { backupToLocalStorage(); resolve(); };
      tx.onerror = (e) => reject(e);
    });
  }

  function updateRecord(record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => { backupToLocalStorage(); resolve(); };
      tx.onerror = (e) => reject(e);
    });
  }

  function getAllRecords() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e);
    });
  }

  function getRecord(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e);
    });
  }

  function getPendingRecords() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result.filter(r => r.synced === false));
      req.onerror = (e) => reject(e);
    });
  }

  function markSynced(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onsuccess = () => {
        const r = req.result;
        if (r) { r.synced = true; store.put(r); }
        tx.oncomplete = () => { backupToLocalStorage(); resolve(); };
      };
      tx.onerror = (e) => reject(e);
    });
  }

  function deleteRecord(id) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => { backupToLocalStorage(); resolve(); };
      tx.onerror = (e) => reject(e);
    });
  }

  function clearAll() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => { localStorage.removeItem(BACKUP_KEY); resolve(); };
      tx.onerror = (e) => reject(e);
    });
  }

  // ==================== BACKUP (doble respaldo) ====================
  async function backupToLocalStorage() {
    try {
      const records = await getAllRecords();
      localStorage.setItem(BACKUP_KEY, JSON.stringify(records));
    } catch (e) { console.error('Backup error:', e); }
  }

  async function restoreFromBackup() {
    try {
      const records = await getAllRecords();
      if (records.length > 0) return; // IndexedDB has data, no need to restore

      const backup = localStorage.getItem(BACKUP_KEY);
      if (!backup) return;

      const data = JSON.parse(backup);
      if (!Array.isArray(data) || data.length === 0) return;

      console.log('Restoring', data.length, 'records from backup');
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const record of data) {
        store.add(record);
      }
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      toast('Datos restaurados del respaldo local', 'info');
    } catch (e) { console.error('Restore error:', e); }
  }

  // ==================== AUTO-FILL PESAJE ====================
  function setupAnimalAutoFill() {
    const select = document.getElementById('p-id');
    if (!select) return;
    select.addEventListener('change', () => {
      const id = select.value;
      if (!id) return;
      getLastLocalPesaje(id).then(local => {
        const source = local || LAST_PESAJE[id];
        if (source) {
          document.getElementById('p-peso-ant').value = source.peso;
          const dias = Math.round((new Date() - new Date(source.fecha)) / 86400000);
          document.getElementById('p-dias').value = dias;
        } else {
          document.getElementById('p-peso-ant').value = '';
          document.getElementById('p-dias').value = '';
        }
      });
    });
  }

  async function getLastLocalPesaje(animalId) {
    const records = await getAllRecords();
    const pesajes = records
      .filter(r => r.type === 'pesajes' && r.animalId === animalId)
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    return pesajes.length > 0 ? { peso: pesajes[0].pesoActual, fecha: pesajes[0].fecha } : null;
  }

  // ==================== AUTO-FILL PRADERA ====================
  async function onCuadraChange(tipo) {
    const prefix = tipo === 'caballos' ? 'pc' : 'pg';
    const cuadra = parseInt(document.getElementById(prefix + '-cuadra').value);
    if (!cuadra) return;

    const infoBox = document.getElementById(prefix + '-info');
    const estadoEl = document.getElementById(prefix + '-estado-auto');
    const diasEl = document.getElementById(prefix + '-dias-descanso-auto');

    const lastEntry = await getLastPraderaEntry(tipo, cuadra);
    if (lastEntry) {
      const now = new Date();
      if (!lastEntry.fechaSalida) {
        estadoEl.textContent = 'En Uso';
        estadoEl.className = 'estado-tag en-uso';
        diasEl.textContent = Math.round((now - new Date(lastEntry.fechaIngreso)) / 86400000) + ' días ocupado';
      } else {
        const diasDescanso = Math.round((now - new Date(lastEntry.fechaSalida)) / 86400000);
        estadoEl.textContent = 'Descanso';
        estadoEl.className = 'estado-tag';
        diasEl.textContent = diasDescanso + ' días de descanso';
      }
      infoBox.style.display = 'flex';
    } else {
      infoBox.style.display = 'none';
    }
  }

  async function getLastPraderaEntry(tipo, cuadra) {
    const records = await getAllRecords();
    const entries = records
      .filter(r => r.type === 'praderas-' + tipo && r.cuadra === cuadra)
      .sort((a, b) => new Date(b.fechaIngreso) - new Date(a.fechaIngreso));
    return entries.length > 0 ? entries[0] : null;
  }

  // ==================== NAVIGATION ====================
  let currentScreen = 'home';

  function goTo(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById('screen-' + screenId);
    if (target) { target.classList.add('active'); window.scrollTo(0, 0); }
    if (screenId === 'historial') renderHistory();
    if (screenId === 'config') loadConfigUI();
    if (screenId === 'praderas-caballos' || screenId === 'praderas-ganado') setDefaultDates();
    // Guardar en historial del navegador para que el botón atrás funcione
    if (screenId !== currentScreen) {
      if (currentScreen === 'home' && screenId !== 'pin') {
        history.pushState({ screen: screenId }, '', '');
      }
      currentScreen = screenId;
    }
  }

  // Botón atrás del celular → volver al home en vez de salirse de la app
  window.addEventListener('popstate', (e) => {
    // Si hay modal abierto, cerrarlo
    const modal = document.getElementById('modal-edit');
    if (modal && modal.style.display === 'flex') {
      closeModal();
      history.pushState({ screen: currentScreen }, '', '');
      return;
    }
    // Si no está en home, volver al home
    if (currentScreen !== 'home') {
      goTo('home');
    }
  });

  // ==================== DEFAULT DATES ====================
  function setDefaultDates() {
    const today = new Date().toISOString().split('T')[0];
    const pFecha = document.getElementById('p-fecha');
    if (pFecha) pFecha.value = today;
    const now = getNowLocalISO();
    ['pc-fecha-in', 'pg-fecha-in'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = now;
    });
  }

  function getNowLocalISO() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function setNow(inputId) {
    const el = document.getElementById(inputId);
    if (el) el.value = getNowLocalISO();
  }

  // ==================== SAVE: PESAJE ====================
  function savePesaje(e) {
    e.preventDefault();
    const idSelect = document.getElementById('p-id').value;
    const idManual = document.getElementById('p-id-manual').value.trim();
    const animalId = idSelect || idManual;
    if (!animalId) { toast('Seleccione o escriba el ID del animal', 'error'); return false; }

    const record = {
      type: 'pesajes',
      animalId: animalId.toUpperCase(),
      fecha: document.getElementById('p-fecha').value,
      pesoActual: parseFloat(document.getElementById('p-peso').value),
      pesoAnterior: parseFloat(document.getElementById('p-peso-ant').value) || null,
      diasDesdeUltimo: parseInt(document.getElementById('p-dias').value) || null,
      observaciones: document.getElementById('p-obs').value.trim()
    };

    addRecord(record).then(() => {
      showBigConfirm('PESAJE GUARDADO');
      e.target.reset();
      setDefaultDates();
      updateSyncBadge();
      tryAutoSync();
    });
    return false;
  }

  // ==================== SAVE: PRADERA ====================
  async function savePradera(e, tipo) {
    e.preventDefault();
    const prefix = tipo === 'caballos' ? 'pc' : 'pg';
    const cuadras = tipo === 'caballos' ? CUADRAS_CABALLOS : CUADRAS_GANADO;

    let cuadra;
    const selectEl = document.getElementById(prefix + '-cuadra');
    const manualEl = document.getElementById(prefix + '-cuadra-manual');
    if (selectEl.value) cuadra = parseInt(selectEl.value);
    else if (manualEl && manualEl.value) cuadra = parseInt(manualEl.value);
    else { toast('Seleccione una cuadra', 'error'); return false; }

    const cuadraData = cuadras[cuadra] || {};
    const fechaIngreso = document.getElementById(prefix + '-fecha-in').value;

    await closePreviousEntry(tipo, cuadra, fechaIngreso);

    const fechaSalida = document.getElementById(prefix + '-fecha-out').value || null;

    const record = {
      type: 'praderas-' + tipo,
      zona: cuadraData.zona || 'Zona 1',
      cuadra: cuadra,
      area: cuadraData.area || null,
      tipoPasto: cuadraData.pasto || '',
      aforo: parseFloat(document.getElementById(prefix + '-aforo').value) || null,
      cargaReal: parseInt(document.getElementById(prefix + '-carga-real').value),
      fechaIngreso: fechaIngreso,
      fechaSalida: fechaSalida,
      observaciones: document.getElementById(prefix + '-obs').value.trim()
    };

    await addRecord(record);
    showBigConfirm('INGRESO REGISTRADO');
    e.target.reset();
    setDefaultDates();
    document.getElementById(prefix + '-info').style.display = 'none';
    updateSyncBadge();
    tryAutoSync();
    return false;
  }

  async function closePreviousEntry(tipo, cuadra, newFechaIngreso) {
    const records = await getAllRecords();
    const prev = records
      .filter(r => r.type === 'praderas-' + tipo && r.cuadra === cuadra && !r.fechaSalida)
      .sort((a, b) => new Date(b.fechaIngreso) - new Date(a.fechaIngreso));
    if (prev.length > 0) {
      prev[0].fechaSalida = newFechaIngreso;
      await updateRecord(prev[0]);
    }
  }

  // ==================== EDIT / DELETE MODAL ====================
  async function openEdit(id) {
    const record = await getRecord(id);
    if (!record) { toast('Registro no encontrado', 'error'); return; }
    editingRecord = record;

    const modal = document.getElementById('modal-edit');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');

    let html = '';
    if (record.type === 'pesajes') {
      title.textContent = 'Editar Pesaje — ' + record.animalId;
      html = `
        <div class="form-group">
          <label>Animal</label>
          <input type="text" id="edit-animalId" value="${record.animalId}">
        </div>
        <div class="form-group">
          <label>Fecha</label>
          <input type="date" id="edit-fecha" value="${record.fecha || ''}">
        </div>
        <div class="form-group">
          <label>Peso actual (kg)</label>
          <input type="number" id="edit-pesoActual" value="${record.pesoActual || ''}" step="0.1" inputmode="decimal">
        </div>
        <div class="form-group">
          <label>Peso anterior (kg)</label>
          <input type="number" id="edit-pesoAnterior" value="${record.pesoAnterior || ''}" step="0.1" inputmode="decimal">
        </div>
        <div class="form-group">
          <label>Días desde último pesaje</label>
          <input type="number" id="edit-diasDesdeUltimo" value="${record.diasDesdeUltimo || ''}" inputmode="numeric">
        </div>
        <div class="form-group">
          <label>Observaciones</label>
          <textarea id="edit-observaciones" rows="2">${record.observaciones || ''}</textarea>
        </div>`;
    } else {
      const tipo = record.type === 'praderas-caballos' ? 'Caballos' : 'Ganado';
      title.textContent = 'Editar Pradera ' + tipo + ' — Cuadra ' + record.cuadra;
      html = `
        <div class="form-group">
          <label>Cuadra</label>
          <input type="number" id="edit-cuadra" value="${record.cuadra}" inputmode="numeric">
        </div>
        <div class="form-group">
          <label>Cantidad de animales</label>
          <input type="number" id="edit-cargaReal" value="${record.cargaReal || ''}" inputmode="numeric">
        </div>
        <div class="form-group">
          <label>Aforo (kg MS/Ha)</label>
          <input type="number" id="edit-aforo" value="${record.aforo || ''}" step="0.1" inputmode="decimal">
        </div>
        <div class="form-group">
          <label>Fecha y hora ingreso</label>
          <input type="datetime-local" id="edit-fechaIngreso" value="${record.fechaIngreso || ''}">
        </div>
        <div class="form-group">
          <label>Fecha y hora salida</label>
          <input type="datetime-local" id="edit-fechaSalida" value="${record.fechaSalida || ''}">
          <small>Dejar vacío si aún están en la cuadra</small>
        </div>
        <div class="form-group">
          <label>Observaciones</label>
          <textarea id="edit-observaciones" rows="2">${record.observaciones || ''}</textarea>
        </div>`;
    }

    body.innerHTML = html;
    modal.style.display = 'flex';
  }

  function closeModal() {
    document.getElementById('modal-edit').style.display = 'none';
    editingRecord = null;
  }

  async function saveEdit() {
    if (!editingRecord) return;
    const r = editingRecord;

    if (r.type === 'pesajes') {
      r.animalId = document.getElementById('edit-animalId').value.trim().toUpperCase();
      r.fecha = document.getElementById('edit-fecha').value;
      r.pesoActual = parseFloat(document.getElementById('edit-pesoActual').value) || null;
      r.pesoAnterior = parseFloat(document.getElementById('edit-pesoAnterior').value) || null;
      r.diasDesdeUltimo = parseInt(document.getElementById('edit-diasDesdeUltimo').value) || null;
      r.observaciones = document.getElementById('edit-observaciones').value.trim();
    } else {
      r.cuadra = parseInt(document.getElementById('edit-cuadra').value);
      r.cargaReal = parseInt(document.getElementById('edit-cargaReal').value) || null;
      r.aforo = parseFloat(document.getElementById('edit-aforo').value) || null;
      r.fechaIngreso = document.getElementById('edit-fechaIngreso').value;
      r.fechaSalida = document.getElementById('edit-fechaSalida').value || null;
      r.observaciones = document.getElementById('edit-observaciones').value.trim();
    }

    // Mark as unsynced so it re-syncs with the correction
    r.synced = false;
    await updateRecord(r);
    closeModal();
    toast('Registro actualizado', 'success');
    renderHistory();
    updateSyncBadge();
  }

  async function confirmDelete() {
    if (!editingRecord) return;
    if (editingRecord.synced) {
      toast('Este registro ya fue sincronizado. No se puede eliminar.', 'error');
      return;
    }
    if (confirm('¿Eliminar este registro? Esta acción no se puede deshacer.')) {
      const id = editingRecord.id;
      closeModal();
      await deleteRecord(id);
      toast('Registro eliminado', 'info');
      renderHistory();
      updateSyncBadge();
    }
  }

  // ==================== SYNC ====================
  let syncInProgress = false;
  let syncRetryTimer = null;

  async function syncNow() {
    if (syncInProgress) return; // Evitar syncs simultáneos
    const config = getConfig();
    if (!config.scriptUrl) { toast('Configure la URL del Apps Script primero', 'error'); goTo('config'); return; }
    if (!navigator.onLine) { toast('Sin conexión. Se sincronizará cuando haya internet.', 'info'); return; }

    syncInProgress = true;
    const btn = document.getElementById('btn-sync');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Sincronizando...'; }

    try {
      const pending = await getPendingRecords();
      if (pending.length === 0) {
        toast('Todo sincronizado', 'success');
        syncInProgress = false;
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Sincronizar ahora'; }
        return;
      }

      let synced = 0;
      let failed = 0;
      for (const record of pending) {
        try {
          const result = await sendToSheet(config.scriptUrl, record);
          if (result.ok) {
            await markSynced(record.id);
            synced++;
          } else {
            failed++;
            console.error('Sync rejected by Sheet:', record.id, result.error);
          }
        } catch (err) {
          failed++;
          console.error('Sync error:', record.id, err);
        }
      }

      if (synced > 0 && failed === 0) {
        toast(`${synced} registro${synced > 1 ? 's' : ''} sincronizado${synced > 1 ? 's' : ''}`, 'success');
      } else if (synced > 0 && failed > 0) {
        toast(`${synced} sincronizado${synced > 1 ? 's' : ''}, ${failed} pendiente${failed > 1 ? 's' : ''} (se reintentará)`, 'info');
        scheduleRetry();
      } else {
        toast(`No se pudo sincronizar. Se reintentará automáticamente.`, 'error');
        scheduleRetry();
      }

      loadAnimalList(config.scriptUrl);
      loadCuadrasList(config.scriptUrl);
    } catch (err) {
      toast('Error de sincronización. Se reintentará.', 'error');
      scheduleRetry();
    } finally {
      syncInProgress = false;
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Sincronizar ahora'; }
      updateSyncBadge();
    }
  }

  // Verificar respuesta real del Apps Script (no solo HTTP 200)
  async function sendToSheet(scriptUrl, record) {
    const payload = encodeURIComponent(JSON.stringify(record));
    const url = scriptUrl + '?action=save&data=' + payload;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const resp = await fetch(url, { redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
      // Leer la respuesta real del Apps Script
      const text = await resp.text();
      try {
        const data = JSON.parse(text);
        if (data.status === 'ok' && data.row) {
          return { ok: true, row: data.row };
        }
        return { ok: false, error: data.message || 'Respuesta inesperada del servidor' };
      } catch (parseErr) {
        // Si Google devolvió HTML o respuesta no-JSON pero HTTP 200,
        // no podemos confirmar que escribió — dejarlo como pendiente
        console.error('Respuesta no-JSON del servidor:', text.substring(0, 200));
        return { ok: false, error: 'Respuesta no válida del servidor' };
      }
    } catch (e) {
      clearTimeout(timeout);
      console.error('sendToSheet failed:', e);
      return { ok: false, error: e.name === 'AbortError' ? 'Tiempo agotado (señal débil)' : e.message };
    }
  }

  // Reintentar sync cada 30 segundos si hay pendientes
  function scheduleRetry() {
    if (syncRetryTimer) return; // Ya hay un reintento programado
    syncRetryTimer = setTimeout(async () => {
      syncRetryTimer = null;
      if (!navigator.onLine) { scheduleRetry(); return; }
      const pending = await getPendingRecords();
      if (pending.length > 0) {
        console.log('Reintentando sync:', pending.length, 'pendientes');
        syncNow();
      }
    }, 30000);
  }

  // Sync periódico: cada 2 minutos verifica si hay pendientes
  function startPeriodicSync() {
    setInterval(async () => {
      if (!navigator.onLine || syncInProgress) return;
      const pending = await getPendingRecords();
      if (pending.length > 0) {
        console.log('Sync periódico:', pending.length, 'pendientes');
        syncNow();
      }
    }, 120000);
  }

  function tryAutoSync() {
    if (navigator.onLine && getConfig().scriptUrl) setTimeout(syncNow, 1500);
  }

  async function loadAnimalList(scriptUrl) {
    try {
      const resp = await fetch(scriptUrl + '?action=getAnimals');
      if (resp.ok) {
        const data = await resp.json();
        if (data.animals && Array.isArray(data.animals)) {
          const config = getConfig();
          config.animales = data.animals;
          localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
          populateAnimalSelect(data.animals);
        }
      }
    } catch (e) { /* use local */ }
  }

  function populateAnimalSelect(animals) {
    const select = document.getElementById('p-id');
    if (!select) return;
    select.innerHTML = '<option value="">-- Seleccionar --</option>';
    animals.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      select.appendChild(opt);
    });
  }

  // ==================== CUADRAS (DESDE SHEET) ====================
  function applyCuadras(caballosList, ganadoList) {
    CUADRAS_CABALLOS = {};
    (caballosList || []).forEach(c => { CUADRAS_CABALLOS[c.cuadra] = c; });
    CUADRAS_GANADO = {};
    (ganadoList || []).forEach(c => { CUADRAS_GANADO[c.cuadra] = c; });
    populateCuadrasSelect('caballos', caballosList || []);
    populateCuadrasSelect('ganado', ganadoList || []);
  }

  async function loadCuadrasList(scriptUrl) {
    try {
      const resp = await fetch(scriptUrl + '?action=getCuadras');
      if (!resp.ok) return;
      const data = await resp.json();
      const cab = Array.isArray(data.caballos) ? data.caballos : null;
      const gan = Array.isArray(data.ganado) ? data.ganado : null;
      if (!cab && !gan) return;
      const config = getConfig();
      if (cab && cab.length > 0) config.cuadrasCaballos = cab;
      if (gan && gan.length > 0) config.cuadrasGanado = gan;
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      applyCuadras(config.cuadrasCaballos, config.cuadrasGanado);
    } catch (e) { /* offline → usa cache local */ }
  }

  function populateCuadrasSelect(tipo, list) {
    const id = tipo === 'caballos' ? 'pc-cuadra' : 'pg-cuadra';
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = '<option value="">-- Seleccionar --</option>';
    list.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.cuadra;
      const unit = tipo === 'caballos' ? ' m²' : ' Ha';
      const areaText = c.area ? ' — ' + c.area + unit : '';
      opt.textContent = 'Cuadra ' + c.cuadra + areaText;
      select.appendChild(opt);
    });
  }

  // ==================== SYNC BADGE ====================
  async function updateSyncBadge() {
    const pending = await getPendingRecords();
    const count = pending.length;
    const badge = document.getElementById('sync-badge');
    const icon = document.getElementById('sync-icon');
    const countEl = document.getElementById('sync-count');
    if (count > 0) {
      badge.classList.add('pending');
      icon.textContent = '⏳';
      countEl.textContent = count + ' pendiente' + (count > 1 ? 's' : '');
    } else {
      badge.classList.remove('pending');
      icon.textContent = '✓';
      countEl.textContent = 'Sincronizado';
    }
  }

  function showPending() { goTo('historial'); }

  // ==================== HISTORY ====================
  let currentFilter = 'todos';

  async function renderHistory(filter) {
    filter = filter || currentFilter;
    const list = document.getElementById('historial-list');
    const records = await getAllRecords();
    const filtered = filter === 'todos' ? records : records.filter(r => r.type === filter);

    if (filtered.length === 0) {
      list.innerHTML = '<p class="empty-msg">No hay registros' + (filter !== 'todos' ? ' de este tipo' : '') + '</p>';
      return;
    }

    filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    list.innerHTML = filtered.map(r => {
      const typeLabels = {
        'pesajes': '⚖️ Pesaje',
        'praderas-caballos': '🐎 P. Caballos',
        'praderas-ganado': '🌿 P. Ganado'
      };

      let body = '';
      if (r.type === 'pesajes') {
        body = `<strong>${r.animalId}</strong> — ${r.pesoActual} kg<br>
                Fecha: ${r.fecha}${r.observaciones ? '<br>' + r.observaciones : ''}`;
      } else {
        const now = new Date();
        let estadoText = '', diasInfo = '';
        if (!r.fechaSalida) {
          estadoText = '<span class="estado-tag en-uso">En Uso</span>';
          diasInfo = Math.round((now - new Date(r.fechaIngreso)) / 86400000) + ' días ocupado';
        } else {
          estadoText = '<span class="estado-tag">Descanso</span>';
          diasInfo = Math.round((now - new Date(r.fechaSalida)) / 86400000) + ' días de descanso';
        }
        body = `<strong>Cuadra ${r.cuadra}</strong> · ${r.zona || ''}<br>
                ${r.cargaReal} animales<br>
                Ingreso: ${formatDateTime(r.fechaIngreso)}<br>
                Salida: ${r.fechaSalida ? formatDateTime(r.fechaSalida) : '—'}<br>
                ${estadoText} <span class="dias-tag">${diasInfo}</span>
                ${r.observaciones ? '<br>' + r.observaciones : ''}`;
      }

      return `
        <div class="record-card ${r.synced ? '' : 'pending-sync'}">
          <div class="record-card__header">
            <span class="record-card__type">${typeLabels[r.type] || r.type}</span>
            <span class="record-card__status ${r.synced ? '' : 'pending'}">
              ${r.synced ? '✓ Sync' : '⏳ Pendiente'}
            </span>
          </div>
          <div class="record-card__body">${body}</div>
          <div class="record-card__actions">
            <button class="record-card__btn record-card__btn--edit" onclick="App.openEdit(${r.id})">✏️ Editar</button>
            ${r.synced ? '' : '<button class="record-card__btn record-card__btn--delete" onclick="App.quickDelete(' + r.id + ')">🗑️ Eliminar</button>'}
          </div>
        </div>`;
    }).join('');
  }

  function formatDateTime(dt) {
    if (!dt) return '—';
    const d = new Date(dt);
    if (isNaN(d)) return dt;
    const p = n => String(n).padStart(2, '0');
    return `${d.getDate()}/${p(d.getMonth()+1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function filterHistory(filter, tabEl) {
    currentFilter = filter;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    if (tabEl) tabEl.classList.add('active');
    renderHistory(filter);
  }

  async function quickDelete(id) {
    const record = await getRecord(id);
    if (!record) return;
    if (record.synced) {
      toast('Este registro ya fue sincronizado. No se puede eliminar.', 'error');
      return;
    }
    if (confirm('¿Eliminar este registro? Esta acción no se puede deshacer.')) {
      await deleteRecord(id);
      toast('Registro eliminado', 'info');
      renderHistory();
      updateSyncBadge();
    }
  }

  // ==================== CONFIG ====================
  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; }
    catch { return {}; }
  }

  function loadConfig() {
    const config = getConfig();
    if (config.animales && config.animales.length > 0) populateAnimalSelect(config.animales);
  }

  function loadConfigUI() {
    const config = getConfig();
    document.getElementById('cfg-script-url').value = config.scriptUrl || '';
    document.getElementById('cfg-pin').value = config.pin || '';
    document.getElementById('cfg-animales').value = (config.animales || []).join(',');
    getAllRecords().then(records => {
      document.getElementById('cfg-total-records').textContent = records.length;
      document.getElementById('cfg-pending-records').textContent = records.filter(r => !r.synced).length;
    });
  }

  function saveConfig() {
    const config = {
      scriptUrl: document.getElementById('cfg-script-url').value.trim(),
      pin: document.getElementById('cfg-pin').value.trim(),
      animales: document.getElementById('cfg-animales').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    populateAnimalSelect(config.animales);
    toast('Configuración guardada', 'success');
  }

  async function clearAllData() {
    const cfg = getConfig();
    if (cfg.pin) {
      const pin = prompt('Ingrese el PIN para borrar datos:');
      if (pin !== cfg.pin) {
        toast('PIN incorrecto. Operación cancelada.', 'error');
        return;
      }
    }
    const pending = await getPendingRecords();
    if (pending.length > 0) {
      if (!confirm('HAY ' + pending.length + ' REGISTROS SIN SINCRONIZAR. Si borra ahora, se PERDERÁN PARA SIEMPRE. ¿Continuar?')) return;
    }
    if (confirm('¿Borrar TODOS los registros locales? No se puede deshacer.')) {
      await clearAll();
      toast('Datos borrados', 'info');
      updateSyncBadge();
    }
  }

  // ==================== TOAST ====================
  function toast(msg, type = 'info') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast ' + type + ' show';
    setTimeout(() => el.classList.remove('show'), 3000);
  }

  // Confirmación grande en pantalla completa para guardar
  function showBigConfirm(msg) {
    const overlay = document.createElement('div');
    overlay.className = 'big-confirm';
    overlay.innerHTML = '<div class="big-confirm__content"><span class="big-confirm__check">&#10003;</span><span class="big-confirm__msg">' + msg + '</span></div>';
    document.body.appendChild(overlay);
    setTimeout(() => { overlay.classList.add('fade-out'); }, 1500);
    setTimeout(() => { overlay.remove(); }, 2000);
  }

  // ==================== SERVICE WORKER ====================
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => console.log('SW registered'))
        .catch(err => console.log('SW error:', err));
    }
  }

  // ==================== INIT ON LOAD ====================
  document.addEventListener('DOMContentLoaded', init);

  return {
    goTo, savePesaje, savePradera, syncNow, showPending,
    filterHistory, quickDelete, saveConfig, clearAllData,
    onCuadraChange, openEdit, closeModal, saveEdit, confirmDelete,
    checkPin, setNow
  };
})();
