import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
} from 'firebase/firestore';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import { auth, db, handleFirestoreError, OperationType } from './firebase.ts';

export interface Registration {
  id: string;
  name: string;
  email: string;
  company: string;
  position: string;
  phone?: string;
  count: number;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EventInfo {
  name?: string;
  date?: string;
  start?: string;
  end?: string;
  addr?: string;
  target?: string;
  bg?: string;
  bgImg?: string;
  dim?: number;
  tc?: string;
  tcc?: string;
  spreadsheetId?: string;
  spreadsheetUrl?: string;
  sheetName?: string;
  sheetAutoSync?: boolean;
  syncedAt?: number;
  updatedAt?: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  lastLogin: number;
}

const BOOTSTRAP_ADMIN_EMAIL = 'imgcut@gmail.com';
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function emailToDocId(email: string): string {
  return email.toLowerCase().replace(/[^a-zA-Z0-9_-]/g, '_');
}

(function () {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

  let registrations: Registration[] = [];
  let currentId: string | null = null;
  let eventData: EventInfo = {};
  let adminUsers: AdminUser[] = [];
  let curAdmin = '';
  let adminOk = false;
  let editId: string | null = null;
  let curView = 'dash';
  let pendingImg = '';
  let currentUser: User | null = null;
  let cachedAccessToken: string | null = null;
  const syncedIds = new Set<string>();

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  function setMsg(el: HTMLElement, text: string, kind: 'ok' | 'err' | 'info') {
    el.textContent = text;
    el.className = 'notice ' + kind;
    el.classList.toggle('hidden', !text);
  }

  function fmt(ts: number) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return (
      d.getFullYear() +
      '.' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '.' +
      String(d.getDate()).padStart(2, '0') +
      ' ' +
      String(d.getHours()).padStart(2, '0') +
      ':' +
      String(d.getMinutes()).padStart(2, '0')
    );
  }

  function maskName(n: string) {
    n = (n || '').trim();
    if (!n) return '-';
    return n.charAt(0) + new Array(Math.max(n.length - 1, 1) + 1).join('*');
  }

  function maskPhone(p?: string) {
    if (!p) return '-';
    const m = String(p).match(/^(\d{2,3})-(\d{3,4})-(\d{4})$/);
    return m ? m[1] + '-****-' + m[3] : '****';
  }

  function setFieldError(id: string, text: string) {
    const el = $(id);
    const er = $(id + 'Err');
    if (el) el.classList.toggle('invalid', !!text);
    if (er) {
      er.textContent = text || '';
      er.classList.toggle('hidden', !text);
    }
  }

  function pinErr(t: string) {
    const er = $('pinErr');
    if (er) {
      er.textContent = t;
      er.classList.toggle('hidden', !t);
    }
  }

  function isEmailAdmin(email?: string | null): boolean {
    if (!email) return false;
    const em = email.toLowerCase().trim();
    if (em === BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) return true;
    return adminUsers.some((a) => (a.email || '').toLowerCase().trim() === em);
  }

  // --- Real-time Firestore Sync ---
  const REG_PATH = 'registrations';
  const EVENT_PATH = 'events';
  const ADMIN_PATH = 'admins';

  // 1. Registrations Real-time Listener
  onSnapshot(
    collection(db, REG_PATH),
    (snapshot) => {
      const list: Registration[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data() as Registration;
        list.push({ ...d, id: docSnap.id });
      });
      registrations = list;
      renderList();
      renderDash();
      if (curView === 'sheets') renderSheetsView();
      // Auto-append un-synced entries if connected and admin has token
      if (cachedAccessToken && eventData.spreadsheetId && eventData.sheetAutoSync !== false) {
        list.forEach((r) => {
          if (!syncedIds.has(r.id)) {
            appendRegistrationToSheet(r, cachedAccessToken!, eventData.spreadsheetId!).catch(() => {});
          }
        });
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, REG_PATH);
    }
  );

  // 2. Event Settings Real-time Listener
  onSnapshot(
    doc(db, EVENT_PATH, 'current'),
    (docSnap) => {
      if (docSnap.exists()) {
        eventData = docSnap.data() as EventInfo;
      } else {
        eventData = {};
      }
      applyEvent();
      if (curView === 'event') fillEventForm();
      if (curView === 'dash') renderDash();
      if (curView === 'sheets') renderSheetsView();
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, `${EVENT_PATH}/current`);
    }
  );

  // 3. Admins Real-time Listener
  onSnapshot(
    collection(db, ADMIN_PATH),
    (snapshot) => {
      const list: AdminUser[] = [];
      snapshot.forEach((docSnap) => {
        list.push(docSnap.data() as AdminUser);
      });
      adminUsers = list;
      if (adminUsers.length === 0 || !adminUsers.some((a) => a.email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase())) {
        ensureSeedAdmin();
      }
      renderAdmins();
      // Re-evaluate admin authorization if user logged in
      if (currentUser) {
        if (isEmailAdmin(currentUser.email)) {
          adminOk = true;
          curAdmin = currentUser.email || '';
        } else {
          adminOk = false;
          curAdmin = '';
        }
      }
      updateWho();
    },
    (error) => {
      console.warn('Admins listener error:', error);
      renderAdmins();
    }
  );

  async function ensureSeedAdmin() {
    const seedId = emailToDocId(BOOTSTRAP_ADMIN_EMAIL);
    const now = Date.now();
    const seed: AdminUser = {
      id: seedId,
      email: BOOTSTRAP_ADMIN_EMAIL,
      name: '최고 관리자',
      createdAt: now,
      updatedAt: now,
      lastLogin: now,
    };
    try {
      await setDoc(doc(db, ADMIN_PATH, seedId), seed);
    } catch (err) {
      console.error('Error seeding bootstrap admin:', err);
    }
  }

  function updateWho() {
    const whoEl = $('whoami');
    if (whoEl) {
      if (currentUser && adminOk) {
        whoEl.textContent = (currentUser.displayName || currentUser.email) + ' (' + currentUser.email + ')';
      } else {
        whoEl.textContent = '';
      }
    }
  }

  function getPathForView(v: string): string {
    if (v === 'dash') return '/admin';
    return '/admin/' + v;
  }

  function navigateTo(path: string) {
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
    syncRoute();
  }

  function syncRoute() {
    const raw = window.location.pathname.replace(/\/+$/, '') || '/';
    if (raw === '/admin' || raw.startsWith('/admin/')) {
      let view = 'dash';
      if (raw === '/admin/list') view = 'list';
      else if (raw === '/admin/sheets') view = 'sheets';
      else if (raw === '/admin/event') view = 'event';
      else if (raw === '/admin/admins') view = 'admins';
      curView = view;
      showTab('admin', false);
      if (adminOk) showView(view, false);
    } else {
      showTab('apply', false);
    }
  }

  function showView(v: string, updateUrl = true) {
    curView = v;
    if (updateUrl) {
      const targetPath = getPathForView(v);
      if (window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath);
      }
    }
    ['dash', 'list', 'sheets', 'event', 'admins'].forEach((k) => {
      const el = $('view' + k.charAt(0).toUpperCase() + k.slice(1));
      if (el) el.classList.toggle('hidden', k !== v);
    });
    const items = document.querySelectorAll('.side-item[data-view]');
    items.forEach((item) => {
      if (item.getAttribute('data-view') === v) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    if (v === 'dash') renderDash();
    if (v === 'list') {
      renderList();
      renderCsvLog();
    }
    if (v === 'sheets') renderSheetsView();
    if (v === 'event') fillEventForm();
    if (v === 'admins') {
      editId = null;
      renderAdmins();
      setAdForm();
    }
    updateWho();
    window.scrollTo(0, 0);
  }

  function showTab(which: 'apply' | 'admin', updateUrl = true) {
    const admin = which === 'admin';
    if (updateUrl) {
      const targetPath = admin ? getPathForView(curView) : '/';
      if (window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath);
      }
    }
    $('panelApply').classList.toggle('hidden', admin);
    $('panelAdmin').classList.toggle('hidden', !admin);
    $('tabAdmin').classList.toggle('hidden', admin);
    $('heroEl').classList.toggle('hidden', admin);
    const topbar = document.querySelector('.topbar');
    if (topbar) topbar.classList.toggle('hidden', admin);
    const wrap = document.querySelector('.wrap');
    if (wrap) wrap.classList.toggle('wide', admin && adminOk);
    if (admin) {
      $('tabApply').classList.toggle('hidden', adminOk);
      $('adminGate').classList.toggle('hidden', adminOk);
      $('adminBody').classList.toggle('hidden', !adminOk);
      if (adminOk) showView(curView, false);
    }
  }

  // --- Google Authentication Handler ---
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user && isEmailAdmin(user.email)) {
      adminOk = true;
      curAdmin = user.email || '';
      updateWho();
      pinErr('');

      const email = user.email || '';
      const docId = emailToDocId(email);
      const existing = adminUsers.find(
        (a) => (a.email || '').toLowerCase() === email.toLowerCase()
      );
      const now = Date.now();
      const adminRecord: AdminUser = {
        id: docId,
        email: email,
        name: user.displayName || existing?.name || email.split('@')[0],
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        lastLogin: now,
      };

      const idx = adminUsers.findIndex((a) => (a.email || '').toLowerCase() === email.toLowerCase());
      if (idx >= 0) {
        adminUsers[idx] = adminRecord;
      } else {
        adminUsers.push(adminRecord);
      }
      renderAdmins();

      try {
        await setDoc(doc(db, ADMIN_PATH, docId), adminRecord);
      } catch (err) {
        console.error('Failed to update admin document in Firestore:', err);
      }

      if (!$('panelAdmin').classList.contains('hidden')) {
        showTab('admin');
      }
    } else if (user) {
      adminOk = false;
      curAdmin = '';
      updateWho();
      pinErr(`'${user.email}' 계정은 등록된 관리자가 아닙니다. 관리자에게 권한을 요청하세요.`);
      if (!$('panelAdmin').classList.contains('hidden')) {
        showTab('admin');
      }
    } else {
      adminOk = false;
      curAdmin = '';
      updateWho();
      if (!$('panelAdmin').classList.contains('hidden')) {
        showTab('admin');
      }
    }
  });

  const googleLoginBtn = $('googleLoginBtn');
  if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', async () => {
      pinErr('');
      const provider = new GoogleAuthProvider();
      SCOPES.forEach((s) => provider.addScope(s));
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        const result = await signInWithPopup(auth, provider);
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential?.accessToken) {
          cachedAccessToken = credential.accessToken;
        }
        const user = result.user;
        if (isEmailAdmin(user.email)) {
          adminOk = true;
          curAdmin = user.email || '';
          navigateTo('/admin');
        } else {
          pinErr(`'${user.email}' 계정은 등록된 관리자가 아닙니다. 관리자에게 권한을 요청하세요.`);
        }
      } catch (error: unknown) {
        const err = error as { code?: string; message?: string };
        if (err.code === 'auth/popup-closed-by-user') {
          pinErr('로그인 팝업 창이 닫혔습니다.');
        } else if (err.code === 'auth/cancelled-popup-request') {
          // Ignored
        } else {
          pinErr('구글 로그인 실패: ' + (err.message || String(error)));
        }
      }
    });
  }

  $('tabApply').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('/');
  });
  $('tabAdmin').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('/admin');
  });
  $('sideApply').addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo('/');
  });
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const v = el.getAttribute('data-view');
      if (v) navigateTo(getPathForView(v));
    });
  });
  $('logoutBtn').addEventListener('click', async () => {
    try {
      await signOut(auth);
    } catch {}
    cachedAccessToken = null;
    adminOk = false;
    curAdmin = '';
    currentUser = null;
    updateWho();
    navigateTo('/');
  });

  // --- Form Validation & Submission ---
  function validate() {
    const name = ($('name') as HTMLInputElement).value.trim();
    const email = ($('email') as HTMLInputElement).value.trim();
    const n = parseInt(($('count') as HTMLInputElement).value, 10);
    if (!name) return '이름을 입력해 주세요.';
    if (!/^[가-힣A-Za-z]{2,30}$/.test(name)) return '이름은 공백 없이 한글 또는 영문 2자 이상으로 입력해 주세요.';
    if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email))
      return '이메일은 영문 이메일 형식(name@example.com)으로 입력해 주세요.';
    if (!($('company') as HTMLInputElement).value.trim()) return '회사명·소속을 입력해 주세요.';
    if (!($('position') as HTMLInputElement).value.trim()) return '직급·직책을 입력해 주세요.';
    const phone = ($('phone') as HTMLInputElement).value.trim();
    if (phone && !/^\d{2,3}-\d{3,4}-\d{4}$/.test(phone))
      return '연락처는 숫자와 - 형식(예: 010-1234-5678)으로 입력해 주세요.';
    if (!(n >= 1 && n <= 10)) return '참석 인원은 1~10명 사이로 입력해 주세요.';
    if (!($('consent') as HTMLInputElement).checked) return '__CONSENT__';
    return '';
  }

  function clearForm() {
    ($('name') as HTMLInputElement).value = '';
    ($('email') as HTMLInputElement).value = '';
    ($('company') as HTMLInputElement).value = '';
    ($('position') as HTMLInputElement).value = '';
    ($('phone') as HTMLInputElement).value = '';
    ($('count') as HTMLInputElement).value = '1';
    ($('note') as HTMLTextAreaElement).value = '';
    $('note').dispatchEvent(new Event('input'));
    ($('consent') as HTMLInputElement).checked = false;
    setFieldError('email', '');
    setFieldError('phone', '');
  }

  function showDone(data: Registration) {
    const dl = $('doneList');
    dl.textContent = '';
    [
      ['이름', data.name],
      ['이메일', data.email],
      ['회사·소속', data.company || '-'],
      ['직급', data.position || '-'],
      ['연락처', data.phone || '-'],
      ['인원', data.count + '명'],
      ['접수', fmt(data.createdAt)],
    ].forEach((p) => {
      const dt = document.createElement('dt');
      dt.textContent = p[0];
      const dd = document.createElement('dd');
      dd.textContent = p[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    $('formBox').classList.add('hidden');
    $('doneBox').classList.remove('hidden');
  }

  function showForm() {
    $('doneBox').classList.add('hidden');
    $('formBox').classList.remove('hidden');
    setMsg($('msg'), '', 'info');
  }

  function resetToNewForm() {
    currentId = null;
    clearForm();
    setMsg($('doneMsg'), '', 'info');
    showForm();
  }

  $('submitBtn').addEventListener('click', async () => {
    setFieldError('email', '');
    setFieldError('phone', '');
    const err = validate();
    if (err === '__CONSENT__') {
      const cmsg = '개인정보 동의 및 파기는 필수 입니다.';
      setMsg($('msg'), cmsg, 'err');
      alert(cmsg);
      return;
    }
    if (err) {
      setMsg($('msg'), err, 'err');
      return;
    }

    const now = Date.now();
    const emailVal = ($('email') as HTMLInputElement).value.trim();
    const phoneVal = ($('phone') as HTMLInputElement).value.trim();
    const phoneKey = phoneVal.replace(/\D/g, '');

    // Duplicate check in Firestore list
    let dupEmail = false;
    let dupPhone = false;
    for (const item of registrations) {
      if (currentId && item.id === currentId) continue;
      if ((item.email || '').toLowerCase() === emailVal.toLowerCase()) dupEmail = true;
      if (phoneKey && (item.phone || '').replace(/\D/g, '') === phoneKey) dupPhone = true;
    }

    if (dupEmail || dupPhone) {
      setFieldError('email', dupEmail ? '중복된 정보를 입력하였습니다.' : '');
      setFieldError('phone', dupPhone ? '중복된 정보를 입력하였습니다.' : '');
      setMsg($('msg'), '', 'info');
      $(dupEmail ? 'email' : 'phone').focus();
      return;
    }

    const submitBtn = $('submitBtn') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = '신청 처리 중...';

    const docId = currentId || 'r' + now.toString(36) + Math.random().toString(36).slice(2, 7);
    const existing = currentId ? registrations.find((r) => r.id === currentId) : null;

    const data: Registration = {
      id: docId,
      name: ($('name') as HTMLInputElement).value.trim(),
      email: emailVal,
      company: ($('company') as HTMLInputElement).value.trim(),
      position: ($('position') as HTMLInputElement).value.trim(),
      phone: phoneVal,
      count: parseInt(($('count') as HTMLInputElement).value, 10),
      note: ($('note') as HTMLTextAreaElement).value.trim(),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    try {
      await setDoc(doc(db, REG_PATH, docId), data);
      currentId = data.id;
      setMsg($('msg'), '', 'info');
      showDone(data);
      setMsg($('doneMsg'), '실시간 데이터베이스에 안전하게 저장되었습니다.', 'ok');

      if (cachedAccessToken && eventData.spreadsheetId) {
        appendRegistrationToSheet(data, cachedAccessToken, eventData.spreadsheetId).catch((e) => {
          console.warn('Google Sheets background sync error:', e);
        });
      }
    } catch (saveError) {
      console.error('Save error:', saveError);
      setMsg($('msg'), '신청 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.', 'err');
      handleFirestoreError(saveError, currentId ? OperationType.UPDATE : OperationType.CREATE, `${REG_PATH}/${docId}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '신청하기';
    }
  });

  $('editBtn').addEventListener('click', () => {
    const item = currentId ? registrations.find((r) => r.id === currentId) : null;
    showForm();
    if (item) {
      ($('name') as HTMLInputElement).value = item.name || '';
      ($('email') as HTMLInputElement).value = item.email || '';
      ($('company') as HTMLInputElement).value = item.company || '';
      ($('position') as HTMLInputElement).value = item.position || '';
      ($('phone') as HTMLInputElement).value = item.phone || '';
      ($('count') as HTMLInputElement).value = String(item.count || 1);
      ($('note') as HTMLTextAreaElement).value = item.note || '';
      $('note').dispatchEvent(new Event('input'));
      ($('consent') as HTMLInputElement).checked = true;
    }
  });

  $('cancelBtn').addEventListener('click', async () => {
    if (!currentId) return;
    if (!confirm('신청을 취소할까요?')) return;
    try {
      await deleteDoc(doc(db, REG_PATH, currentId));
      resetToNewForm();
      setMsg($('msg'), '신청이 취소되었습니다.', 'ok');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `${REG_PATH}/${currentId}`);
    }
  });

  $('newBtn').addEventListener('click', resetToNewForm);

  // --- Real-time List and Dash Rendering ---
  function dayKey(ts: number) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function mkRow(vals: string[]) {
    const tr = document.createElement('tr');
    vals.forEach((v) => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });
    return tr;
  }

  function renderDash() {
    const sorted = registrations.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    let total = 0;
    sorted.forEach((r) => {
      total += r.count || 1;
    });
    const n = sorted.length;
    $('kCount').textContent = n + '건';
    $('kCountSub').textContent = n ? '최초 등록 ' + fmt(sorted[n - 1].createdAt) : '아직 신청이 없습니다';
    $('kPeople').textContent = total + '명';
    $('kPeopleSub').textContent = n ? '신청 1건당 평균 ' + (total / n).toFixed(1) + '명' : '-';
    $('kLast').textContent = n ? fmt(sorted[0].createdAt) : '-';
    $('kLastSub').textContent = n ? maskName(sorted[0].name) + ' · ' + (sorted[0].company || '-') : '-';
    const today = dayKey(Date.now());
    let tc = 0;
    let tp = 0;
    sorted.forEach((r) => {
      if (dayKey(r.createdAt) === today) {
        tc++;
        tp += r.count || 1;
      }
    });
    $('kToday').textContent = tc + '건';
    $('kTodaySub').textContent = '인원 ' + tp + '명';

    // 7-day Trend Chart
    const box = $('dTrend');
    box.textContent = '';
    const days: { key: string; label: string; c: number }[] = [];
    let max = 1;
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      days.push({ key: dayKey(d.getTime()), label: d.getMonth() + 1 + '/' + d.getDate(), c: 0 });
    }
    sorted.forEach((r) => {
      days.forEach((x) => {
        if (x.key === dayKey(r.createdAt)) x.c++;
      });
    });
    days.forEach((x) => {
      if (x.c > max) max = x.c;
    });
    days.forEach((x) => {
      const col = document.createElement('div');
      col.className = 'bar';
      const b = document.createElement('b');
      b.textContent = String(x.c);
      const bar = document.createElement('i');
      bar.style.height = Math.round((x.c / max) * 100) + '%';
      const lb = document.createElement('span');
      lb.textContent = x.label;
      col.appendChild(b);
      col.appendChild(bar);
      col.appendChild(lb);
      box.appendChild(col);
    });

    // Event Summary
    const dl = $('dEvent');
    dl.textContent = '';
    [
      ['이름', eventData.name || '미설정'],
      ['일시', eventData.date ? whenText(eventData) : '미설정'],
      ['장소', eventData.addr || '미설정'],
      ['대상', eventData.target || '미설정'],
    ].forEach((p) => {
      const dt = document.createElement('dt');
      dt.textContent = p[0];
      const dd = document.createElement('dd');
      dd.textContent = p[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    let dd0 = '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventData.date || '');
    if (m) {
      const t0 = new Date();
      t0.setHours(0, 0, 0, 0);
      const diff = Math.round((new Date(+m[1], +m[2] - 1, +m[3]).getTime() - t0.getTime()) / 86400000);
      dd0 = diff === 0 ? 'D-Day' : diff > 0 ? 'D-' + diff : '종료 D+' + -diff;
    }
    $('dDday').textContent = dd0;
    $('dDday').classList.toggle('hidden', !dd0);

    // Recent 5 entries
    const rb = $('dRecent');
    rb.textContent = '';
    if (!n) {
      const tr0 = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.colSpan = 4;
      td0.style.color = 'var(--muted)';
      td0.textContent = '저장된 신청이 없습니다.';
      tr0.appendChild(td0);
      rb.appendChild(tr0);
    }
    sorted.slice(0, 5).forEach((r) => {
      rb.appendChild(mkRow([fmt(r.createdAt), maskName(r.name), r.company || '-', String(r.count || 1)]));
    });
  }

  function renderList() {
    const all = registrations.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const searchInput = $('listSearch') as HTMLInputElement | null;
    const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const list = q ? all.filter((r) => (r.email || '').toLowerCase().indexOf(q) >= 0) : all;
    const tb = $('listRows');
    tb.textContent = '';
    let total = 0;
    if (!list.length) {
      const tr0 = document.createElement('tr');
      const td0 = document.createElement('td');
      td0.colSpan = 8;
      td0.textContent = all.length
        ? '"' + (searchInput?.value.trim() || '') + '" 이메일 검색 결과가 없습니다.'
        : '저장된 신청이 없습니다.';
      td0.style.color = 'var(--muted)';
      tr0.appendChild(td0);
      tb.appendChild(tr0);
    }
    list.forEach((r) => {
      total += r.count || 1;
      const tr = document.createElement('tr');
      [fmt(r.createdAt), maskName(r.name), r.email, r.company, r.position, maskPhone(r.phone), String(r.count || 1)].forEach(
        (v) => {
          const td = document.createElement('td');
          td.textContent = v == null ? '' : v;
          tr.appendChild(td);
        }
      );
      const tdDel = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'btn ghost';
      btn.style.padding = '6px 10px';
      btn.style.fontSize = '13px';
      btn.textContent = '삭제';
      btn.addEventListener('click', () => removeEntry(r.id));
      tdDel.appendChild(btn);
      tr.appendChild(tdDel);
      tb.appendChild(tr);
    });
    $('listCount').textContent =
      (q ? '검색 ' + list.length + '건 / 전체 ' + all.length + '건' : list.length + '건') + ' · 총 ' + total + '명';
    renderDash();
  }

  async function removeEntry(id: string) {
    if (!confirm('이 신청을 삭제할까요?')) return;
    try {
      await deleteDoc(doc(db, REG_PATH, id));
      if (id === currentId) resetToNewForm();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `${REG_PATH}/${id}`);
    }
  }

  $('clearAllBtn').addEventListener('click', async () => {
    if (!registrations.length) return;
    if (!confirm('모든 신청 내역을 데이터베이스에서 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
    try {
      const snap = await getDocs(collection(db, REG_PATH));
      const promises: Promise<void>[] = [];
      snap.forEach((d) => promises.push(deleteDoc(d.ref)));
      await Promise.all(promises);
      resetToNewForm();
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, REG_PATH);
    }
  });

  $('listSearch').addEventListener('input', renderList);
  $('listSearch').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      (this as HTMLInputElement).value = '';
      renderList();
    }
  });
  $('listSearchClear').addEventListener('click', () => {
    ($('listSearch') as HTMLInputElement).value = '';
    renderList();
    $('listSearch').focus();
  });

  // --- CSV Export ---
  const CSV_LOG_KEY = 'event_csv_log_v1';
  function csvLogLoad() {
    try {
      const r = localStorage.getItem(CSV_LOG_KEY);
      const a = r ? JSON.parse(r) : [];
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  function csvLogAdd(by: string, rows: number) {
    let a = csvLogLoad();
    a.push({ at: Date.now(), by, rows });
    a = a.slice(-20);
    try {
      localStorage.setItem(CSV_LOG_KEY, JSON.stringify(a));
    } catch {}
    renderCsvLog();
  }
  function renderCsvLog() {
    const a = csvLogLoad();
    const el = $('csvLog');
    el.textContent = a.length
      ? '최근 CSV 다운로드: ' +
        fmt(a[a.length - 1].at) +
        ' · ' +
        a[a.length - 1].by +
        ' · ' +
        a[a.length - 1].rows +
        '건 (누적 ' +
        a.length +
        '회)'
      : '아직 CSV를 다운로드한 기록이 없습니다.';
  }
  function csvCell(v: unknown) {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function isoTime(ts: number) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      p(d.getMonth() + 1) +
      '-' +
      p(d.getDate()) +
      ' ' +
      p(d.getHours()) +
      ':' +
      p(d.getMinutes())
    );
  }
  function downloadCsv() {
    const list = registrations.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!list.length) {
      alert('다운로드할 신청 내역이 없습니다.');
      return;
    }
    if (
      !confirm(
        '실명·이메일·연락처 원본이 포함된 CSV를 내려받습니다.\n안전한 곳에만 보관하고, 이벤트 종료 후 파기해 주세요.\n\n계속할까요?'
      )
    )
      return;
    const head = [
      '순번',
      '접수일시',
      '수정일시',
      '이름',
      '이메일',
      '회사·소속',
      '직급·직책',
      '연락처',
      '참석인원',
      '남기실 말씀',
    ];
    const lines = [head.map(csvCell).join(',')];
    list.forEach((r, i) => {
      lines.push(
        [
          i + 1,
          isoTime(r.createdAt),
          isoTime(r.updatedAt || r.createdAt),
          r.name,
          r.email,
          r.company,
          r.position,
          r.phone || '',
          r.count || 1,
          r.note || '',
        ]
          .map(csvCell)
          .join(',')
      );
    });
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const fname =
      'signups_' +
      now.getFullYear() +
      p(now.getMonth() + 1) +
      p(now.getDate()) +
      '_' +
      p(now.getHours()) +
      p(now.getMinutes()) +
      '.csv';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    csvLogAdd(curAdmin || '-', list.length);
  }
  $('csvBtn').addEventListener('click', downloadCsv);

  // --- Google Sheets Integration ---
  async function ensureGoogleSheetsToken(): Promise<string> {
    if (cachedAccessToken) return cachedAccessToken;
    const provider = new GoogleAuthProvider();
    SCOPES.forEach((s) => provider.addScope(s));
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (!credential?.accessToken) {
        throw new Error('Google 스프레드시트 접근 토큰을 발급받지 못했습니다.');
      }
      cachedAccessToken = credential.accessToken;
      return cachedAccessToken;
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string };
      if (errObj.code === 'auth/popup-closed-by-user') {
        throw new Error('인증 팝업 창이 닫혔습니다. 다시 시도해 주세요.');
      }
      throw new Error(errObj.message || 'Google 인증에 실패했습니다.');
    }
  }

  async function createSpreadsheet(customTitle?: string): Promise<{ id: string; url: string }> {
    const token = await ensureGoogleSheetsToken();
    const sheetTitle = (customTitle || eventData.name || '이벤트 참가 신청자 명단') + ' (실시간 연동)';

    const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: { title: sheetTitle },
        sheets: [
          {
            properties: {
              title: '신청자목록',
              gridProperties: {
                frozenRowCount: 1,
              },
            },
          },
        ],
      }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || '스프레드시트 생성 실패 (' + res.status + ')');
    }

    const data = await res.json();
    const sid = data.spreadsheetId as string;
    const surl = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${sid}/edit`;

    eventData.spreadsheetId = sid;
    eventData.spreadsheetUrl = surl;
    eventData.sheetName = sheetTitle;
    eventData.sheetAutoSync = true;
    eventData.syncedAt = Date.now();
    eventData.updatedAt = Date.now();

    await setDoc(doc(db, EVENT_PATH, 'current'), eventData);
    await syncAllToSheet(sid, token);

    return { id: sid, url: surl };
  }

  async function syncAllToSheet(sid: string, token: string): Promise<void> {
    const list = registrations.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const headers = [
      '순번',
      '접수일시',
      '이름(마스킹)',
      '이메일',
      '회사·소속',
      '직급·직책',
      '연락처(마스킹)',
      '참석인원',
      '남기실 말씀',
      '신청ID',
    ];

    const rows = list.map((r, i) => [
      i + 1,
      fmt(r.createdAt),
      maskName(r.name),
      r.email,
      r.company || '-',
      r.position || '-',
      maskPhone(r.phone),
      r.count || 1,
      r.note || '-',
      r.id,
    ]);

    const values = [headers, ...rows];

    // Try writing to '신청자목록' sheet
    let res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/신청자목록!A1:J${Math.max(values.length, 50)}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          range: `신청자목록!A1:J${values.length}`,
          majorDimension: 'ROWS',
          values: values,
        }),
      }
    );

    if (!res.ok) {
      // Fallback without explicit sheet name (for existing/default sheets)
      res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/A1:J${values.length}?valueInputOption=USER_ENTERED`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            range: `A1:J${values.length}`,
            majorDimension: 'ROWS',
            values: values,
          }),
        }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error?.message || '스프레드시트 데이터 동기화 실패 (' + res.status + ')');
      }
    }

    list.forEach((r) => syncedIds.add(r.id));
    eventData.syncedAt = Date.now();
    eventData.updatedAt = Date.now();
    await setDoc(doc(db, EVENT_PATH, 'current'), eventData);
  }

  async function appendRegistrationToSheet(reg: Registration, token: string, sid: string): Promise<void> {
    const list = registrations.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const rowIdx = Math.max(list.findIndex((x) => x.id === reg.id) + 1, list.length);
    const row = [
      rowIdx,
      fmt(reg.createdAt),
      maskName(reg.name),
      reg.email,
      reg.company || '-',
      reg.position || '-',
      maskPhone(reg.phone),
      reg.count || 1,
      reg.note || '-',
      reg.id,
    ];

    try {
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/신청자목록!A:J:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            values: [row],
          }),
        }
      );
      if (!res.ok) throw new Error('Append failed');
    } catch {
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/A:J:append?valueInputOption=USER_ENTERED`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            values: [row],
          }),
        }
      ).catch(() => {});
    }
    syncedIds.add(reg.id);
  }

  function renderSheetsView() {
    const connected = !!eventData.spreadsheetId;
    const badge = $('sheetStatusBadge');
    if (badge) {
      badge.textContent = connected ? '연동 완료' : '미연동';
      badge.style.background = connected ? 'var(--ok-bg)' : '';
      badge.style.color = connected ? 'var(--ok)' : '';
    }
    const nameEl = $('sheetDocName');
    if (nameEl) {
      nameEl.textContent = eventData.sheetName || (connected ? 'Google 스프레드시트' : '연결된 구글 시트가 없습니다');
    }
    const idEl = $('sheetDocId');
    if (idEl) {
      idEl.textContent = eventData.spreadsheetId || '-';
    }
    const syncEl = $('sheetLastSync');
    if (syncEl) {
      syncEl.textContent = eventData.syncedAt ? fmt(eventData.syncedAt) : '-';
    }

    const openBtn = $('openSheetBtn') as HTMLAnchorElement | null;
    if (openBtn) {
      openBtn.classList.toggle('hidden', !connected);
      if (connected) {
        openBtn.href = eventData.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${eventData.spreadsheetId}/edit`;
      }
    }

    const unlinkBtn = $('unlinkSheetBtn');
    if (unlinkBtn) unlinkBtn.classList.toggle('hidden', !connected);

    const createBtn = $('createSheetBtn');
    if (createBtn) {
      createBtn.textContent = connected ? '새 구글 시트로 다시 생성' : '새 구글 시트 생성 및 자동 연동';
    }

    // Render Preview Table
    const tb = $('sheetPreviewRows');
    if (tb) {
      tb.textContent = '';
      const list = registrations.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      if (!list.length) {
        const tr0 = document.createElement('tr');
        const td0 = document.createElement('td');
        td0.colSpan = 7;
        td0.style.color = 'var(--muted)';
        td0.textContent = '아직 등록된 신청 데이터가 없습니다.';
        tr0.appendChild(td0);
        tb.appendChild(tr0);
      } else {
        list.slice(0, 15).forEach((r) => {
          const tr = document.createElement('tr');
          [
            fmt(r.createdAt),
            maskName(r.name),
            r.email,
            r.company || '-',
            r.position || '-',
            maskPhone(r.phone),
            String(r.count || 1),
          ].forEach((v, idx) => {
            const td = document.createElement('td');
            td.textContent = v;
            if (idx === 1 || idx === 5) {
              td.style.fontWeight = '600';
              td.style.color = 'var(--accent)';
            }
            tr.appendChild(td);
          });
          tb.appendChild(tr);
        });
      }
    }
    const countEl = $('sheetPreviewCount');
    if (countEl) countEl.textContent = registrations.length + '건';
  }

  // Event handlers for Sheets View
  const createSheetBtn = $('createSheetBtn');
  if (createSheetBtn) {
    createSheetBtn.addEventListener('click', async () => {
      const m = $('sheetMsg');
      setMsg(m, 'Google 스프레드시트를 생성하고 신청자 명단을 연동 중입니다...', 'info');
      try {
        await createSpreadsheet();
        setMsg(m, 'Google 스프레드시트가 성공적으로 생성 및 연동되었습니다!', 'ok');
        renderSheetsView();
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setMsg(m, '스프레드시트 연동 실패: ' + errorMsg, 'err');
      }
    });
  }

  const syncSheetBtn = $('syncSheetBtn');
  if (syncSheetBtn) {
    syncSheetBtn.addEventListener('click', async () => {
      const m = $('sheetMsg');
      if (!eventData.spreadsheetId) {
        setMsg(m, '먼저 Google 스프레드시트를 생성하거나 연결해 주세요.', 'err');
        return;
      }
      if (!confirm('현재 등록된 모든 신청 데이터(이름/연락처 마스킹 적용)를 Google 시트에 동기화할까요?')) return;
      setMsg(m, '스프레드시트에 동기화 중입니다...', 'info');
      try {
        const token = await ensureGoogleSheetsToken();
        await syncAllToSheet(eventData.spreadsheetId, token);
        setMsg(m, '총 ' + registrations.length + '건의 신청 데이터가 구글 시트에 안전하게 동기화되었습니다 (마스킹 적용).', 'ok');
        renderSheetsView();
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setMsg(m, '동기화 실패: ' + errorMsg, 'err');
      }
    });
  }

  const unlinkSheetBtn = $('unlinkSheetBtn');
  if (unlinkSheetBtn) {
    unlinkSheetBtn.addEventListener('click', async () => {
      const m = $('sheetMsg');
      if (!confirm('Google 스프레드시트 연동을 해제하시겠습니까?\n(Google 드라이브의 실제 파일은 삭제되지 않습니다)')) return;
      eventData.spreadsheetId = '';
      eventData.spreadsheetUrl = '';
      eventData.sheetName = '';
      eventData.syncedAt = 0;
      try {
        await setDoc(doc(db, EVENT_PATH, 'current'), eventData);
        setMsg(m, '스프레드시트 연동이 해제되었습니다.', 'info');
        renderSheetsView();
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setMsg(m, '연동 해제 실패: ' + errorMsg, 'err');
      }
    });
  }

  const manualSheetConnectBtn = $('manualSheetConnectBtn');
  if (manualSheetConnectBtn) {
    manualSheetConnectBtn.addEventListener('click', async () => {
      const m = $('sheetMsg');
      const input = ($('manualSheetInput') as HTMLInputElement).value.trim();
      if (!input) {
        setMsg(m, '스프레드시트 URL 또는 ID를 입력해 주세요.', 'err');
        return;
      }
      const match = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      const sid = match ? match[1] : input;
      setMsg(m, '스프레드시트 확인 및 연동 중...', 'info');
      try {
        const token = await ensureGoogleSheetsToken();
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error('시트 정보를 읽을 수 없습니다. 시트 ID 및 공유 권한을 확인해 주세요.');
        }
        const sheetMeta = await res.json();
        eventData.spreadsheetId = sid;
        eventData.spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${sid}/edit`;
        eventData.sheetName = sheetMeta.properties?.title || '연결된 스프레드시트';
        eventData.sheetAutoSync = true;
        eventData.syncedAt = Date.now();
        await setDoc(doc(db, EVENT_PATH, 'current'), eventData);
        await syncAllToSheet(sid, token);
        setMsg(m, `'${eventData.sheetName}' 시트가 성공적으로 연결 및 동기화되었습니다!`, 'ok');
        ($('manualSheetInput') as HTMLInputElement).value = '';
        renderSheetsView();
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setMsg(m, '시트 연결 실패: ' + errorMsg, 'err');
      }
    });
  }

  const listSyncSheetBtn = $('listSyncSheetBtn');
  if (listSyncSheetBtn) {
    listSyncSheetBtn.addEventListener('click', () => {
      navigateTo('/admin/sheets');
    });
  }

  // --- Admin Management (Google Accounts) ---
  function renderAdmins() {
    const tb = $('adRows');
    tb.textContent = '';

    // Build complete display list including currentUser and BOOTSTRAP_ADMIN_EMAIL
    const map = new Map<string, AdminUser>();
    adminUsers.forEach((a) => {
      if (a.email) map.set(a.email.toLowerCase(), a);
    });

    // Ensure bootstrap admin is present
    const bootKey = BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    if (!map.has(bootKey)) {
      map.set(bootKey, {
        id: emailToDocId(BOOTSTRAP_ADMIN_EMAIL),
        email: BOOTSTRAP_ADMIN_EMAIL,
        name: '최고 관리자',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastLogin: Date.now(),
      });
    }

    // Ensure logged-in admin is present
    if (currentUser && currentUser.email && isEmailAdmin(currentUser.email)) {
      const myKey = currentUser.email.toLowerCase();
      if (!map.has(myKey)) {
        map.set(myKey, {
          id: emailToDocId(currentUser.email),
          email: currentUser.email,
          name: currentUser.displayName || currentUser.email.split('@')[0],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lastLogin: Date.now(),
        });
      }
    }

    const displayList = Array.from(map.values()).sort((a, b) => {
      // Primary admin first, then recent
      if (a.email.toLowerCase() === bootKey) return -1;
      if (b.email.toLowerCase() === bootKey) return 1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    displayList.forEach((a) => {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.textContent = a.email;
      const isMe = currentUser && (currentUser.email || '').toLowerCase() === (a.email || '').toLowerCase();
      if (isMe) {
        const me = document.createElement('span');
        me.className = 'me';
        me.textContent = '나';
        td.appendChild(me);
      }
      tr.appendChild(td);
      [a.name || '-', fmt(a.createdAt), a.lastLogin ? fmt(a.lastLogin) : '-'].forEach((v) => {
        const c = document.createElement('td');
        c.textContent = v;
        tr.appendChild(c);
      });
      const act = document.createElement('td');
      const dbBtn = document.createElement('button');
      dbBtn.type = 'button';
      dbBtn.className = 'btn ghost';
      dbBtn.style.cssText = 'padding:6px 10px;font-size:13px';
      dbBtn.textContent = '삭제';
      const isPrimary = (a.email || '').toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
      if (isMe || isPrimary || displayList.length < 2) {
        dbBtn.disabled = true;
        dbBtn.style.opacity = '.45';
        dbBtn.title = isPrimary
          ? '최고 관리자 계정은 삭제할 수 없습니다.'
          : isMe
          ? '현재 로그인 중인 계정은 삭제할 수 없습니다.'
          : '마지막 관리자는 삭제할 수 없습니다.';
      }
      dbBtn.addEventListener('click', () => delAdmin(a.id, a.email));
      act.appendChild(dbBtn);
      tr.appendChild(act);
      tb.appendChild(tr);
    });
    $('adCount').textContent = displayList.length + '명';
  }

  function setAdForm() {
    $('adFormTitle').textContent = '관리자 구글 계정 추가';
    ($('adEmail') as HTMLInputElement).value = '';
    ($('adName') as HTMLInputElement).value = '';
    $('adSave').textContent = '추가';
  }

  async function saveAdmin() {
    const m = $('adMsg');
    const email = ($('adEmail') as HTMLInputElement).value.trim();
    const name = ($('adName') as HTMLInputElement).value.trim();
    if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}$/.test(email)) {
      setMsg(m, '올바른 구글 이메일 형식(name@example.com)을 입력해 주세요.', 'err');
      return;
    }
    const exists = adminUsers.some((a) => a.email.toLowerCase() === email.toLowerCase());
    if (exists) {
      setMsg(m, '이미 관리자로 등록된 이메일 계정입니다.', 'err');
      return;
    }
    const docId = emailToDocId(email);
    const now = Date.now();
    const na: AdminUser = {
      id: docId,
      email,
      name: name || '',
      createdAt: now,
      updatedAt: now,
      lastLogin: 0,
    };
    try {
      await setDoc(doc(db, ADMIN_PATH, docId), na);
      setAdForm();
      setMsg(m, '관리자 구글 계정이 추가되었습니다: ' + email, 'ok');
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `${ADMIN_PATH}/${docId}`);
    }
  }

  async function delAdmin(id: string, email: string) {
    if (currentUser && (currentUser.email || '').toLowerCase() === email.toLowerCase()) {
      setMsg($('adListMsg'), '로그인 중인 본인 계정은 삭제할 수 없습니다.', 'err');
      return;
    }
    if (email.toLowerCase() === BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) {
      setMsg($('adListMsg'), '최고 관리자 계정은 삭제할 수 없습니다.', 'err');
      return;
    }
    if (!confirm(email + ' 계정을 관리자에서 삭제할까요?')) return;
    try {
      await deleteDoc(doc(db, ADMIN_PATH, id));
      setMsg($('adListMsg'), email + ' 계정이 관리자에서 삭제되었습니다.', 'ok');
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `${ADMIN_PATH}/${id}`);
    }
  }

  $('adSave').addEventListener('click', saveAdmin);
  $('adCancel').addEventListener('click', () => {
    setAdForm();
    setMsg($('adMsg'), '', 'info');
  });

  // --- Event Information & Banner Settings ---
  function dowText(v?: string) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
    if (!m) return '';
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() !== +m[2] - 1 ? '' : DOW[d.getDay()];
  }

  function whenText(o: EventInfo) {
    const w = dowText(o.date);
    if (!w) return '0000년 00월 00일 (요일) 00:00';
    const p = (o.date || '').split('-');
    const t = o.start ? ' ' + o.start + (o.end ? ' ~ ' + o.end : '') : '';
    return p[0] + '년 ' + p[1] + '월 ' + p[2] + '일 (' + w + ')' + t;
  }

  function lum(hex?: string) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 1;
    const n = parseInt(m[1], 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  function paintHero(el: HTMLElement, o: EventInfo) {
    const img = o.bgImg && /^data:image\//.test(o.bgImg) ? o.bgImg : '';
    const col = o.bg && /^#[0-9a-f]{6}$/i.test(o.bg) ? o.bg : '';
    const styled = !!(img || col);
    el.classList.toggle('styled', styled);
    el.style.backgroundColor = col;
    if (img) {
      const d = (o.dim == null ? 35 : o.dim) / 100;
      el.style.backgroundImage = 'linear-gradient(rgba(0,0,0,' + d + '),rgba(0,0,0,' + d + ')),url("' + img + '")';
    } else el.style.backgroundImage = '';
    const tc = o.tc || 'auto';
    const cc = o.tcc && /^#[0-9a-f]{6}$/i.test(o.tcc) ? o.tcc : '#ffffff';
    el.classList.toggle('tcol', styled || tc !== 'auto');
    let fg: string;
    if (tc === 'custom') fg = cc;
    else if (tc === 'light') fg = '#ffffff';
    else if (tc === 'dark') fg = '#111111';
    else fg = img || lum(col) < 0.55 ? '#ffffff' : '#111111';
    el.style.setProperty('--hfg', fg);
    el.style.setProperty('--hfg2', 'color-mix(in srgb,' + fg + ' 85%,transparent)');
  }

  function applyEvent() {
    $('evTitle').textContent = eventData.name || '이벤트 이름을 입력하세요';
    $('evWhen').textContent = whenText(eventData);
    $('evPlace').textContent = eventData.addr || '장소 또는 온라인 링크 안내';
    $('evTarget').textContent = eventData.target || '참가 대상 안내';
    if (eventData.name) document.title = eventData.name + ' 참가 신청';
    paintHero($('heroEl'), eventData);
  }

  function formObj(): EventInfo {
    return {
      name: ($('evName') as HTMLInputElement).value.trim(),
      date: ($('evDate') as HTMLInputElement).value,
      start: ($('evStart') as HTMLInputElement).value,
      end: ($('evEnd') as HTMLInputElement).value,
      addr: ($('evAddr') as HTMLInputElement).value.trim(),
      target: ($('evTgt') as HTMLInputElement).value.trim(),
      bg: ($('evBgOn') as HTMLInputElement).checked ? ($('evBgColor') as HTMLInputElement).value : '',
      bgImg: pendingImg,
      dim: parseInt(($('evDim') as HTMLInputElement).value, 10),
      tc: ($('evTc') as HTMLSelectElement).value,
      tcc: ($('evTcColor') as HTMLInputElement).value,
      updatedAt: Date.now(),
    };
  }

  function evPrev() {
    const o = formObj();
    const p = $('heroPrev');
    $('evDimVal').textContent = o.dim + '%';
    $('evTcColor').classList.toggle('hidden', o.tc !== 'custom');
    p.textContent = '';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '참가 신청';
    const h = document.createElement('h1');
    h.textContent = o.name || '이벤트 이름을 입력하세요';
    const ul = document.createElement('ul');
    ul.className = 'meta';
    [
      ['일시', whenText(o)],
      ['장소', o.addr || '장소 또는 온라인 링크 안내'],
      ['대상', o.target || '참가 대상 안내'],
    ].forEach((r) => {
      const li = document.createElement('li');
      const b = document.createElement('b');
      const sp = document.createElement('span');
      b.textContent = r[0];
      sp.textContent = r[1];
      li.appendChild(b);
      li.appendChild(sp);
      ul.appendChild(li);
    });
    p.appendChild(tag);
    p.appendChild(h);
    p.appendChild(ul);
    paintHero(p, o);
  }

  function fillEventForm() {
    ($('evName') as HTMLInputElement).value = eventData.name || '';
    ($('evDate') as HTMLInputElement).value = eventData.date || '';
    ($('evStart') as HTMLInputElement).value = eventData.start || '';
    ($('evEnd') as HTMLInputElement).value = eventData.end || '';
    ($('evAddr') as HTMLInputElement).value = eventData.addr || '';
    ($('evTgt') as HTMLInputElement).value = eventData.target || '';
    ($('evBgOn') as HTMLInputElement).checked = !!eventData.bg;
    ($('evBgColor') as HTMLInputElement).value = eventData.bg || '#3b5bdb';
    pendingImg = eventData.bgImg || '';
    ($('evDim') as HTMLInputElement).value = String(eventData.dim == null ? 35 : eventData.dim);
    ($('evTc') as HTMLSelectElement).value = eventData.tc || 'auto';
    ($('evTcColor') as HTMLInputElement).value = eventData.tcc || '#ffffff';
    ($('evImgFile') as HTMLInputElement).value = '';
    $('evImgInfo').textContent = pendingImg
      ? '이미지가 적용되어 있습니다.'
      : '이미지는 가로 1280px 이내로 자동 축소되어 저장됩니다.';
    updateDow();
    evPrev();
  }

  // Color Swatches
  ['#3b5bdb', '#0f172a', '#1f7a4d', '#7c3aed', '#b42318', '#f59e0b'].forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sw';
    b.style.background = c;
    b.setAttribute('aria-label', '배경 색상 ' + c);
    b.addEventListener('click', () => {
      ($('evBgColor') as HTMLInputElement).value = c;
      ($('evBgOn') as HTMLInputElement).checked = true;
      evPrev();
    });
    $('evSw').appendChild(b);
  });

  $('evBgColor').addEventListener('input', () => {
    ($('evBgOn') as HTMLInputElement).checked = true;
  });
  $('eventCard').addEventListener('input', evPrev);
  $('eventCard').addEventListener('change', evPrev);

  $('evImgFile').addEventListener('change', function () {
    const f = (this as HTMLInputElement).files && (this as HTMLInputElement).files![0];
    if (!f) return;
    if (!/^image\//.test(f.type) || f.size > 15 * 1024 * 1024) {
      setMsg($('evMsg'), '15MB 이하의 이미지 파일만 사용할 수 있습니다.', 'err');
      (this as HTMLInputElement).value = '';
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        const sc = Math.min(1, 1280 / im.width);
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * sc);
        c.height = Math.round(im.height * sc);
        c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height);
        pendingImg = c.toDataURL('image/jpeg', 0.82);
        $('evImgInfo').textContent =
          '이미지가 선택되었습니다. 저장을 눌러야 적용됩니다. (약 ' +
          Math.round((pendingImg.length * 0.75) / 1024) +
          'KB)';
        evPrev();
      };
      im.onerror = () => setMsg($('evMsg'), '이미지를 읽을 수 없습니다.', 'err');
      im.src = fr.result as string;
    };
    fr.readAsDataURL(f);
  });

  $('evImgDel').addEventListener('click', () => {
    pendingImg = '';
    ($('evImgFile') as HTMLInputElement).value = '';
    $('evImgInfo').textContent = '이미지를 삭제했습니다. 저장을 눌러야 적용됩니다.';
    evPrev();
  });

  function updateDow() {
    const w = dowText(($('evDate') as HTMLInputElement).value);
    $('evDow').textContent = w ? '선택한 요일: ' + w + '요일' : '';
  }

  $('evDate').addEventListener('input', updateDow);
  $('evDate').addEventListener('change', updateDow);

  $('evSave').addEventListener('click', async () => {
    const o = formObj();
    if (o.start && o.end && o.end <= o.start) {
      setMsg($('evMsg'), '끝나는 시간은 시작 시간보다 늦어야 합니다.', 'err');
      return;
    }
    try {
      await setDoc(doc(db, EVENT_PATH, 'current'), o);
      applyEvent();
      setMsg($('evMsg'), '저장되었습니다. 실시간으로 참가자 화면에 반영됩니다.', 'ok');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${EVENT_PATH}/current`);
    }
  });

  $('evReset').addEventListener('click', async () => {
    if (!confirm('이벤트 정보를 모두 초기화할까요?')) return;
    try {
      await setDoc(doc(db, EVENT_PATH, 'current'), {});
      fillEventForm();
      applyEvent();
      setMsg($('evMsg'), '초기화되었습니다.', 'info');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `${EVENT_PATH}/current`);
    }
  });

  // --- Input Filtering & Auto-Formatting ---
  function bindFilter(el: HTMLInputElement | HTMLTextAreaElement, re: RegExp, after?: (e: typeof el) => void) {
    let composing = false;
    function clean() {
      const v = el.value.replace(re, '');
      if (v !== el.value) el.value = v;
      if (after) after(el);
    }
    el.addEventListener('compositionstart', () => {
      composing = true;
    });
    el.addEventListener('compositionend', () => {
      composing = false;
      clean();
    });
    el.addEventListener('input', () => {
      if (composing) {
        if (after) after(el);
      } else {
        clean();
      }
    });
  }

  function updateNoteCount(el: HTMLInputElement | HTMLTextAreaElement) {
    $('noteCount').textContent = el.value.length + '/500';
  }

  bindFilter($('name') as HTMLInputElement, /[^가-힣A-Za-z]/g);
  bindFilter($('email') as HTMLInputElement, /[^A-Za-z0-9._%+\-@]/g);
  bindFilter(
    $('note') as HTMLTextAreaElement,
    /[^\u0020-\u007E\n\r\t가-힣ㄱ-ㅎㅏ-ㅣ\u2018\u2019\u201C\u201D\u00B7\u2026]/g,
    updateNoteCount
  );

  $('phone').addEventListener('input', function () {
    const input = this as HTMLInputElement;
    let d = input.value.replace(/\D/g, '');
    const a = d.indexOf('02') === 0 ? 2 : 3;
    d = d.slice(0, a === 2 ? 10 : 11);
    let out = d;
    if (d.length > a) out = d.slice(0, a) + '-' + d.slice(a);
    if (d.length > a + 4) out = d.slice(0, a) + '-' + d.slice(a, a + 4) + '-' + d.slice(a + 4);
    input.value = out;
  });

  const cnt = $('count') as HTMLInputElement;
  cnt.addEventListener('keydown', (e) => {
    if (['e', 'E', '+', '-', '.'].indexOf(e.key) >= 0) e.preventDefault();
  });
  cnt.addEventListener('input', () => {
    const n = parseInt(cnt.value, 10);
    if (n > 10) cnt.value = '10';
    if (n < 1) cnt.value = '1';
  });
  cnt.addEventListener('blur', () => {
    if (!cnt.value || parseInt(cnt.value, 10) < 1) cnt.value = '1';
  });

  ['email', 'phone'].forEach((id) => {
    $(id).addEventListener('input', () => setFieldError(id, ''));
  });

  // History popstate listener for back/forward browser buttons
  window.addEventListener('popstate', () => {
    syncRoute();
  });

  // Initial routing and render
  syncRoute();
  applyEvent();
  renderList();
})();
