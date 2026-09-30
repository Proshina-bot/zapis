/* ============================================================
 * PRO-шина · CRM — app.js v3.6
 *
 * ФИКСЫ ВТОРОЙ ВОЛНЫ:
 *  - POST для write-запросов (решает CORS с saveSalaryDay)
 *  - GET для read-запросов
 *  - Api.getVersion() — умный опрос (getVersion → bootstrap только если изменилось)
 *  - Utils.getTimeSlots: фикс UTC-парсинга (T00:00:00)
 *  - State.lastDataVersion — запоминаем версию данных
 * ============================================================ */

(function() {
    'use strict';

    var Config = {
        APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzHm6I_4sSUbU7QqYOFoEpF8Nsn6nv7Aph8alxJOddylQIfVLdb1Ksr1WnJctKitm2d/exec',
        CARS: ['1', '2', '3'],
        SIZES: ['R13','R14','R15','R16','R17','R18','R19','R20','R21','R22','R23'],
        REFRESH_INTERVAL: 120000,
        FETCH_TIMEOUT: 20000,
        FETCH_TIMEOUT_SALARY: 30000,
        MAX_RETRIES: 2,
        MAX_RETRIES_SALARY: 1,
        AUTOSAVE_INTERVAL: 30000,
        LOCAL_CACHE_KEY: 'proshina_cache_v4',
        LOCAL_CACHE_MAX_AGE: 600000,
        SESSION_SALARY_KEY: 'proshina_salary_month_v1',
        SESSION_SALARY_MAX_AGE: 900000,
        PHONE_PREFIX: '+7 ( ',
        OPTIMISTIC_TTL: 60000,
        VERIFY_DELAY: 15000
    };

    // ============================================================
    // 💾 LOCAL CACHE
    // ============================================================
    var LocalCache = {
        _idleHandle: null,
        _pending: null,
        save: function(data) {
            this._pending = {
                records: data.records || null,
                prices: data.prices || null,
                masters: data.masters || null,
                ts: Date.now()
            };
            if (this._idleHandle) return;
            var self = this;
            var flush = function() {
                self._idleHandle = null;
                if (!self._pending) return;
                try {
                    var json = JSON.stringify(self._pending);
                    self._pending = null;
                    localStorage.setItem(Config.LOCAL_CACHE_KEY, json);
                } catch (e) { self._pending = null; }
            };
            if (typeof requestIdleCallback !== 'undefined') {
                this._idleHandle = requestIdleCallback(flush, { timeout: 2000 });
            } else {
                this._idleHandle = setTimeout(flush, 500);
            }
        },
        load: function() {
            try {
                var raw = localStorage.getItem(Config.LOCAL_CACHE_KEY);
                if (!raw) return null;
                var parsed = JSON.parse(raw);
                if (!parsed.ts) return null;
                var age = Date.now() - parsed.ts;
                if (age > Config.LOCAL_CACHE_MAX_AGE) return null;
                return { data: parsed, age: age };
            } catch (e) { return null; }
        },
        clear: function() {
            try { localStorage.removeItem(Config.LOCAL_CACHE_KEY); } catch (e) {}
        }
    };

    var SalaryCache = {
        save: function(key, data) {
            try {
                sessionStorage.setItem(Config.SESSION_SALARY_KEY + '_' + key, JSON.stringify({
                    data: data, ts: Date.now()
                }));
            } catch (e) {}
        },
        load: function(key) {
            try {
                var raw = sessionStorage.getItem(Config.SESSION_SALARY_KEY + '_' + key);
                if (!raw) return null;
                var parsed = JSON.parse(raw);
                if (!parsed.ts) return null;
                if ((Date.now() - parsed.ts) > Config.SESSION_SALARY_MAX_AGE) {
                    sessionStorage.removeItem(Config.SESSION_SALARY_KEY + '_' + key);
                    return null;
                }
                return parsed.data;
            } catch (e) { return null; }
        },
        clear: function(key) {
            try { sessionStorage.removeItem(Config.SESSION_SALARY_KEY + '_' + key); } catch (e) {}
        },
        clearAll: function() {
            try {
                var keys = Object.keys(sessionStorage);
                keys.forEach(function(k) {
                    if (k.indexOf(Config.SESSION_SALARY_KEY) === 0) sessionStorage.removeItem(k);
                });
            } catch (e) {}
        }
    };

    // ============================================================
    // 🗄 STATE
    // ============================================================
    var State = {
        occupiedSlots: {},
        clientsDatabase: {},
        submitInFlight: {},

        journalVersion: 0,
        clientsVersion: 0,

        tetradkaLoadFailed: false,

        currentBranch: 'ryabinina',
        currentSelection: { date: null, time: null, car: null, slotKey: null },
        selectedServices: [],
        selectedSize: '',
        clientRating: null,
        notificationMethod: 'whatsapp',

        priceBranch: 'ryabinina',
        prices: { ryabinina: null, amundsena: null },
        pricesLoaded: false,

        tetradkaBranch: 'ryabinina',
        tetradkaDate: null,
        mastersList: [],
        tetradka: { ryabinina: null, amundsena: null },
        tetradkaLoaded: { ryabinina: false, amundsena: false },
        hideProcessedRecords: false,
        carsHideCount: 0,

        zarpBranch: 'ryabinina',
        zarpYear: new Date().getFullYear(),
        zarpMonth: new Date().getMonth(),
        salaryMonthData: null,
        salaryMonthLoadedKey: null,

        isUpdating: false,
        lastBootstrapAt: 0,
        bootstrapInFlight: null,

        // 🔑 версия данных (для умного опроса)
        lastDataVersion: null
    };

    // ============================================================
    // 🌐 API
    // ============================================================
    var Api = {
        _fetchWithTimeout: function(url, timeout, opts) {
            return new Promise(function(resolve, reject) {
                var controller = new AbortController();
                var timer = setTimeout(function() { controller.abort(); reject(new Error('timeout')); }, timeout);
                var fetchOpts = Object.assign({ signal: controller.signal }, opts || {});
                fetch(url, fetchOpts)
                    .then(function(res) {
                        clearTimeout(timer);
                        if (!res.ok) reject(new Error('HTTP ' + res.status));
                        else resolve(res);
                    })
                    .catch(function(e) { clearTimeout(timer); reject(e); });
            });
        },

        // 🔑 _fetch с поддержкой POST
        _fetch: function(params, retries, timeout, usePost) {
            retries = (retries === undefined) ? Config.MAX_RETRIES : retries;
            timeout = timeout || Config.FETCH_TIMEOUT;
            var self = this;
            var attempt = 0;

            var url, opts;
            if (usePost) {
                // 🔑 POST — body JSON, content-type text/plain (без preflight)
                url = Config.APPS_SCRIPT_URL;
                opts = {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify(Object.assign({}, params, { _: Date.now() }))
                };
            } else {
                // GET — маленькие запросы
                url = Config.APPS_SCRIPT_URL + '?' + new URLSearchParams(
                    Object.assign({}, params, { _: Date.now() })
                ).toString();
                opts = {};
            }

            function tryOnce() {
                return self._fetchWithTimeout(url, timeout, opts)
                    .then(function(res) { return res.json(); })
                    .catch(function(e) {
                        if (attempt >= retries) { return null; }
                        attempt++;
                        return new Promise(function(r) { setTimeout(r, 400); }).then(tryOnce);
                    });
            }
            return tryOnce();
        },

        ping: function() { return Api._fetch({ action: 'ping' }, 0, 5000); },

        // 🔑 Лёгкий запрос версии
        getVersion: function() {
            return Api._fetch({ action: 'getVersion' }, 0, 5000);
        },

        getBootstrap: function() {
            if (State.bootstrapInFlight) return State.bootstrapInFlight;
            State.bootstrapInFlight = Api._fetch({ action: 'getBootstrap' }, 2, 25000).then(function(r) {
                State.bootstrapInFlight = null;
                if (r && !r.error) State.lastBootstrapAt = Date.now();
                return r;
            });
            return State.bootstrapInFlight;
        },
        getAll: function() { return Api._fetch({ action: 'getAll' }); },

        // 🔑 WRITE-запросы → POST
        createRecord: function(data) {
            return Api._fetch(Object.assign({ action: 'new' }, data), 0, 20000, true);
        },
        deleteRecord: function(slotKey) {
            return Api._fetch({ action: 'delete', slotKey: slotKey }, 0, 20000, true);
        },
        moveRecord: function(oldKey, newKey, data) {
            return Api._fetch(Object.assign({ action: 'move', oldSlotKey: oldKey, newSlotKey: newKey }, data), 0, 20000, true);
        },
        saveExtra: function(slotKey, extraComment, rating, phone) {
            return Api._fetch({ action: 'saveExtraComment', slotKey: slotKey, extraComment: extraComment, rating: rating, phone: phone }, 0, 20000, true);
        },
        saveExtraBatch: function(keys, extraComment, rating) {
            return Api._fetch({
                action: 'saveExtraBatch',
                keys: JSON.stringify(keys),
                extraComment: extraComment,
                rating: rating
            }, 0, 20000, true);
        },
        saveSalaryDay: function(data) {
            return Api._fetch(Object.assign({ action: 'saveSalaryDay' }, data), 0, 30000, true);
        },
        addMark: function(data) {
            return Api._fetch(Object.assign({ action: 'addMark' }, data), 0, 20000, true);
        },
        deleteMark: function(id) {
            return Api._fetch({ action: 'deleteMark', id: id }, 0, 20000, true);
        },
        closeMonth: function(data) {
            return Api._fetch(Object.assign({ action: 'closeMonth' }, data), 0, 30000, true);
        },
        updateRecordStatus: function(recordKey, status) {
            return Api._fetch({ action: 'updateRecordStatus', recordKey: recordKey, status: status }, 0, 15000, true);
        },

        // 🔑 READ-запросы → GET
        getPrices: function() { return Api._fetch({ action: 'getPrices' }); },
        getMasters: function() { return Api._fetch({ action: 'getMasters' }); },
        getSalaryDay: function(date, branch) { return Api._fetch({ action: 'getSalaryDay', date: date, branch: branch }); },
        getSalaryMonth: function(year, month) {
            return Api._fetch({ action: 'getSalaryMonth', year: year, month: month }, Config.MAX_RETRIES_SALARY, Config.FETCH_TIMEOUT_SALARY);
        },
        getRecordPayment: function(recordKey) {
            return Api._fetch({ action: 'getRecordPayment', recordKey: recordKey });
        }
    };

    // ============================================================
    // 🔧 UTILS
    // ============================================================
    var Utils = {
        normalizeSlotKey: function(key) {
            if (!key) return '';
            var parts = String(key).split('_');
            if (parts.length < 4) return key;
            var branch = parts[0], date = parts[1], time = parts[2], car = parts[3];
            time = String(time).replace(/^(\d{1,2}):(\d{2})(?::\d{2})?$/, function(m, h, mm) {
                return h.padStart(2, '0') + ':' + mm;
            });
            return branch + '_' + date + '_' + time + '_' + car;
        },
        normalizeAllKeys: function(obj) {
            var out = {};
            Object.keys(obj || {}).forEach(function(key) {
                out[Utils.normalizeSlotKey(key)] = obj[key];
            });
            return out;
        },

        formatPhone: function(value, cursorPos) {
            var digits = value.replace(/\D/g, '');
            if (digits.length > 0 && (digits[0] === '7' || digits[0] === '8')) {
                digits = digits.substring(1);
            }
            digits = digits.substring(0, 10);

            var result = '+7';
            if (digits.length > 0) {
                result += ' (' + digits.substring(0, 3);
                if (digits.length > 3) {
                    result += ') ' + digits.substring(3, 6);
                    if (digits.length > 6) {
                        result += '-' + digits.substring(6, 8);
                        if (digits.length > 8) {
                            result += '-' + digits.substring(8, 10);
                        }
                    }
                }
            } else {
                result += ' (';
            }

            var cursor = cursorPos === undefined ? value.length : cursorPos;
            var digitsBefore = value.substring(0, cursor).replace(/\D/g, '');
            if (digitsBefore.length > 0 && (digitsBefore[0] === '7' || digitsBefore[0] === '8')) {
                digitsBefore = digitsBefore.substring(1);
            }
            var digitCount = digitsBefore.length;

            var newPos = result.length;
            if (digitCount > 0) {
                var seen = 0;
                var skipLeading7 = true;
                for (var i = 0; i < result.length; i++) {
                    var ch = result[i];
                    if (/\d/.test(ch)) {
                        if (skipLeading7 && ch === '7') {
                            skipLeading7 = false;
                            continue;
                        }
                        skipLeading7 = false;
                        seen++;
                        if (seen >= digitCount) {
                            newPos = i + 1;
                            break;
                        }
                    }
                }
            }

            return { value: result, cursor: newPos };
        },

        cleanPhone: function(p) { return p ? p.replace(/\D/g, '') : ''; },
        capitalizeName: function(n) {
            if (!n) return n;
            return n.split(' ').map(function(w) {
                return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
            }).join(' ');
        },
        formatDate: function(s) {
            if (!s) return '—';
            var p = String(s).split('-');
            return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : s;
        },

        // 🔑 ФИКС UTC-парсинга: 'YYYY-MM-DD' + 'T00:00:00'
        getTimeSlots: function(date) {
            if (!date) return [];
            var d = new Date(date + 'T00:00:00');
            var isWeekend = d.getDay() === 0 || d.getDay() === 6;
            var start = isWeekend ? 10 : 9;
            var end = isWeekend ? 20 : 21;
            var slots = [];
            for (var h = start; h < end; h++) {
                if (h === 14) slots.push('14:30');
                else {
                    slots.push(String(h).padStart(2, '0') + ':00');
                    slots.push(String(h).padStart(2, '0') + ':30');
                }
            }
            return slots;
        },
        parseServices: function(s) {
            if (Array.isArray(s)) return s;
            if (!s) return [];
            return String(s).split(',').map(function(x) { return x.trim(); }).filter(Boolean);
        },
        formatPrice: function(value) {
            if (value === undefined || value === null || value === '') return null;
            if (typeof value === 'number') return Number(value).toLocaleString('ru-RU') + ' ₽';
            var s = String(value).trim();
            if (!s) return null;
            if (s.indexOf('/') !== -1) {
                return s.split('/').map(function(p) {
                    var t = p.trim();
                    var num = Number(t.replace(/\s/g, ''));
                    return (!isNaN(num) && /^\d+$/.test(t)) ? num.toLocaleString('ru-RU') : t;
                }).join(' / ') + ' ₽';
            }
            var num2 = Number(s.replace(/\s/g, ''));
            if (!isNaN(num2) && /^\d+$/.test(s.replace(/\s/g, ''))) return num2.toLocaleString('ru-RU') + ' ₽';
            return s;
        },
        isJunkExtraInfo: function(text) {
            if (!text) return true;
            var t = String(text).trim().toLowerCase();
            if (!t) return true;
            return ['нет ничего', 'нет', 'пусто', '-', '—', 'nan', 'undefined', 'null'].indexOf(t) !== -1;
        },
        calcRating: function(client) {
            var total = client.visits || 1;
            return (client.goodCount * 5 + client.badCount * 0 + client.neutralCount * 3) / total;
        },
        formatRating: function(client) { return Utils.calcRating(client).toFixed(1); },
        debounce: function(fn, ms) {
            var t;
            return function() {
                var args = arguments, ctx = this;
                clearTimeout(t);
                t = setTimeout(function() { fn.apply(ctx, args); }, ms);
            };
        },
        fmtMoney: function(n) {
            n = Number(n) || 0;
            return n.toLocaleString('ru-RU') + ' ₽';
        },
        escapeHtml: function(str) {
            if (str === null || str === undefined) return '';
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        },
        numToInput: function(n) {
            var num = Number(n);
            if (isNaN(num) || num === 0) return '';
            return String(num);
        }
    };

    var UI = {
        $: function(id) { return document.getElementById(id); },
        toast: function(message, type, duration) {
            type = type || 'info';
            duration = duration || 3000;
            var icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
            var el = document.createElement('div');
            el.className = 'toast ' + type;
            el.innerHTML = '<span class="icon">' + (icons[type] || 'ℹ') + '</span><span>' + Utils.escapeHtml(message) + '</span>';
            UI.$('toastContainer').appendChild(el);
            setTimeout(function() {
                el.classList.add('out');
                setTimeout(function() { el.remove(); }, 300);
            }, duration);
        },
        setLoading: function(btnId, loading, textId, loadingText) {
            var btn = UI.$(btnId);
            if (!btn) return;
            btn.disabled = loading;

            var textEl = textId ? UI.$(textId) : null;
            if (!textEl || !textEl.parentNode) textEl = btn;

            if (loading) {
                if (textEl._originalText === undefined) {
                    textEl._originalText = textEl.textContent || '';
                }
                textEl.innerHTML = '<span class="spinner"></span> ' + (loadingText || 'Загрузка...');
            } else {
                if (textEl._originalText !== undefined) {
                    textEl.textContent = textEl._originalText;
                    delete textEl._originalText;
                }
            }
        },
        skeletonSlots: function(count) {
            count = count || 6;
            var html = '';
            for (var i = 0; i < count; i++) {
                html += '<div class="time-row" style="pointer-events:none"><div class="skeleton" style="flex:1;height:100%"></div></div>';
            }
            return html;
        },
        updateLoadIndicator: function(percent) {
            var el = UI.$('loadIndicator');
            var txt = UI.$('loadText');
            if (!el || !txt) return;
            el.classList.remove('low', 'medium', 'high');
            var cls, label;
            if (percent < 30) { cls = 'low'; label = 'Низкая'; }
            else if (percent < 70) { cls = 'medium'; label = 'Средняя'; }
            else { cls = 'high'; label = 'Высокая'; }
            el.classList.add(cls);
            txt.textContent = label + ' · ' + percent + '%';
        }
    };

    var Payments = {
        data: {
            bn: { label: 'Б/Н' }, cash: { label: 'Нал' }, card: { label: 'Карта' },
            almir: { label: 'Альмир' }, sbp: { label: 'СБП' }, invoice: { label: 'По счёту' }
        },
        label: function(code) { return Payments.data[code] ? Payments.data[code].label : code; },
        all: function() { return Object.keys(Payments.data); }
    };

    // ============================================================
    // 📝 NEW RECORD
    // ============================================================
    var NewRecord = {
        initPhone: function() {
            var el = UI.$('phone');
            if (!el) return;
            if (!el.value || el.value.trim() === '' || el.value.trim() === '+7') {
                el.value = Config.PHONE_PREFIX;
            }
        },

        init: function() {
            flatpickr(UI.$('datePicker'), {
                dateFormat: 'Y-m-d',
                defaultDate: new Date(),
                locale: 'ru',
                onChange: function() {
                    State.currentSelection = { date: null, time: null, car: null, slotKey: null };
                    UI.$('slotInfoBanner').classList.remove('show');
                    NewRecord.renderSlots();
                }
            });

            var todayBtn = UI.$('todayBtn');
            if (todayBtn) {
                todayBtn.addEventListener('click', function() {
                    var now = new Date();
                    var today = now.getFullYear() + '-' +
                        String(now.getMonth() + 1).padStart(2, '0') + '-' +
                        String(now.getDate()).padStart(2, '0');
                    var datePicker = UI.$('datePicker');
                    if (datePicker._flatpickr) {
                        datePicker._flatpickr.setDate(today, true);
                    } else {
                        datePicker.value = today;
                        State.currentSelection = { date: null, time: null, car: null, slotKey: null };
                        UI.$('slotInfoBanner').classList.remove('show');
                        NewRecord.renderSlots();
                    }
                });
            }

            document.querySelectorAll('#newRecordBranchSelector .branch-btn-lg').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('#newRecordBranchSelector .branch-btn-lg').forEach(function(b) { b.classList.remove('active'); });
                    this.classList.add('active');
                    State.currentBranch = this.dataset.branch;
                    State.currentSelection = { date: null, time: null, car: null, slotKey: null };
                    UI.$('slotInfoBanner').classList.remove('show');
                    NewRecord.renderServicesGrid();
                    NewRecord.renderSlots();
                });
            });

            UI.$('ratingGood').addEventListener('click', function() {
                App.setRating(State.clientRating === 'good' ? null : 'good');
            });
            UI.$('ratingBad').addEventListener('click', function() {
                App.setRating(State.clientRating === 'bad' ? null : 'bad');
            });

            document.querySelectorAll('.notify-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.notify-btn').forEach(function(b) { b.classList.remove('active'); });
                    this.classList.add('active');
                    State.notificationMethod = this.dataset.notify;
                });
            });

            var sizesFragment = document.createDocumentFragment();
            Config.SIZES.forEach(function(size) {
                var btn = document.createElement('button');
                btn.className = 'size-btn';
                btn.textContent = size;
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.size-btn').forEach(function(b) { b.classList.remove('selected'); });
                    this.classList.add('selected');
                    State.selectedSize = size;
                    NewRecord.updateSubmitState();
                });
                sizesFragment.appendChild(btn);
            });
            UI.$('sizesGrid').appendChild(sizesFragment);

            var phoneEl = UI.$('phone');
            NewRecord.initPhone();
            phoneEl.addEventListener('focus', function() {
                if (!this.value || this.value.trim() === '' || this.value.trim() === '+7') {
                    this.value = Config.PHONE_PREFIX;
                    var self = this;
                    setTimeout(function() { self.setSelectionRange(self.value.length, self.value.length); }, 0);
                }
            });
            phoneEl.addEventListener('input', function() {
                var cursor = this.selectionStart;
                var res = Utils.formatPhone(this.value, cursor);
                this.value = res.value;
                try { this.setSelectionRange(res.cursor, res.cursor); } catch (e) {}
                App.checkClientByPhone();
                NewRecord.updateSubmitState();
            });

            UI.$('submitBtn').addEventListener('click', NewRecord.submit);

            NewRecord.renderServicesGrid();
        },

        renderServicesGrid: function() {
            if (!State.currentBranch) State.currentBranch = 'ryabinina';
            var list = State.currentBranch === 'ryabinina'
                ? ['Комплекс', 'СУ+Баланс', 'Ремонт', 'Правка']
                : ['Комплекс', 'СУ+Баланс', 'Ремонт', 'Правка', 'Кондиционер', 'Слесарка'];

            var grid = UI.$('servicesGrid');
            if (!grid) return;
            grid.innerHTML = '';
            State.selectedServices = [];
            var fragment = document.createDocumentFragment();

            list.forEach(function(svc) {
                var btn = document.createElement('button');
                btn.className = 'service-btn';
                btn.dataset.service = svc;
                btn.innerHTML = '<span>' + Utils.escapeHtml(svc) + '</span>';
                btn.addEventListener('click', function() {
                    var idx = State.selectedServices.indexOf(svc);
                    if (idx === -1) {
                        State.selectedServices.push(svc);
                        this.classList.add('selected');
                    } else {
                        State.selectedServices.splice(idx, 1);
                        this.classList.remove('selected');
                    }
                    NewRecord.updateSubmitState();
                });
                fragment.appendChild(btn);
            });
            grid.appendChild(fragment);
        },

        renderSlots: function() {
            var date = UI.$('datePicker').value;
            if (!date) return;

            var container = UI.$('slotsContainer');
            var slots = Utils.getTimeSlots(date);
            var currentBranch = State.currentBranch;

            var html = '';
            var freeCount = 0;
            var totalSlots = 0;

            slots.forEach(function(time) {
                var isLunch = time === '14:00';
                html += '<div class="time-row' + (isLunch ? ' lunch' : '') + '">';
                html += '<div class="time-label">' + (isLunch ? '14:00<br><small>ОБЕД</small>' : time) + '</div>';
                html += '<div class="slots-row">';

                if (isLunch) {
                    for (var i = 0; i < Config.CARS.length; i++) {
                        html += '<div class="slot occupied"><span class="brand">🚫</span></div>';
                    }
                } else {
                    Config.CARS.forEach(function(car) {
                        var slotKey = Utils.normalizeSlotKey(currentBranch + '_' + date + '_' + time + '_' + car);
                        var occ = State.occupiedSlots[slotKey];
                        totalSlots++;
                        if (occ) {
                            var rating = occ.rating || 'neutral';
                            var hasComment = occ.comment || occ.extraComment;
                            var phone = Utils.cleanPhone(occ.phone || '');
                            var client = State.clientsDatabase[phone];
                            var visits = client ? client.visits : 0;
                            var services = Utils.parseServices(occ.services);
                            var servicesLine = services.length
                                ? services.map(function(s) { return s === 'СУ+Баланс' ? 'СУ+Б' : s; }).join(' · ')
                                : '';

                            var ratingNum = '', ratingCls = 'neutral';
                            if (client) {
                                ratingNum = Utils.formatRating(client);
                                if (client.rating === 'good') ratingCls = 'good';
                                else if (client.rating === 'bad') ratingCls = 'bad';
                            }

                            var cls = 'slot occupied ';
                            if (rating === 'good') cls += 'good';
                            else if (rating === 'bad') cls += 'bad';
                            else cls += 'no-rating';

                            html += '<div class="' + cls + '" ' +
                                    'data-slot-key="' + slotKey + '" ' +
                                    'data-slot-occupied="1">' +
                                '<span class="brand">' + Utils.escapeHtml(occ.carBrand || '???') + '</span>' +
                                (servicesLine ? '<span class="services-line">' + Utils.escapeHtml(servicesLine) + '</span>' : '') +
                                '<span class="rating-line">' +
                                    (ratingNum ? '<span class="rating-num ' + ratingCls + '">' + ratingNum + '</span>' : '') +
                                    (visits > 1 ? '<span class="visits-badge">' + visits + '</span>' : '') +
                                '</span>' +
                                (hasComment ? '<span class="comment-dot"></span>' : '') +
                            '</div>';
                        } else {
                            freeCount++;
                            html += '<div class="slot free" ' +
                                    'data-time="' + time + '" ' +
                                    'data-car="' + car + '" ' +
                                    'data-slot-key="' + slotKey + '">ПУСТО</div>';
                        }
                    });
                }
                html += '</div></div>';
            });

            container.innerHTML = html;

            if (!container._hasDelegatedClick) {
                container.addEventListener('click', function(e) {
                    var slotEl = e.target.closest('.slot');
                    if (!slotEl) return;
                    var slotKey = slotEl.dataset.slotKey;
                    if (!slotKey) return;
                    if (slotEl.dataset.slotOccupied === '1') {
                        Records.openModal(slotKey);
                    } else {
                        var time = slotEl.dataset.time;
                        var car = slotEl.dataset.car;
                        if (time && car) NewRecord.selectSlot(time, car);
                    }
                });
                container._hasDelegatedClick = true;
            }

            UI.$('freeCounter').textContent = freeCount + ' свободно';
            var booked = totalSlots - freeCount;
            var percent = totalSlots > 0 ? Math.round((booked / totalSlots) * 100) : 0;
            UI.updateLoadIndicator(percent);
            NewRecord.updateSubmitState();
            App.updateStats();
        },

        selectSlot: function(time, car) {
            document.querySelectorAll('.slot.free').forEach(function(s) { s.classList.remove('selected'); });
            var slot = document.querySelector('.slot.free[data-time="' + time + '"][data-car="' + car + '"]');
            if (slot) slot.classList.add('selected');

            State.currentSelection = {
                date: UI.$('datePicker').value,
                time: time,
                car: car,
                slotKey: Utils.normalizeSlotKey(State.currentBranch + '_' + UI.$('datePicker').value + '_' + time + '_' + car)
            };
            NewRecord.renderInfoBanner();
            NewRecord.updateSubmitState();
        },

        renderInfoBanner: function() {
            var el = UI.$('slotInfoBanner');
            if (!State.currentSelection.slotKey) { el.classList.remove('show'); return; }
            var branchName = State.currentBranch === 'ryabinina' ? '🏠 Рябинина, 47/1' : '🏭 Амундсена 119/6';
            el.innerHTML =
                '<div class="line"><span class="key">Дата:</span> <span class="val">' + Utils.formatDate(State.currentSelection.date) + '</span></div>' +
                '<div class="line"><span class="key">Время:</span> <span class="val">' + State.currentSelection.time + '</span></div>' +
                '<div class="line"><span class="key">Филиал:</span> <span class="val">' + branchName + '</span></div>';
            el.classList.add('show');
        },

        updateSubmitState: function() {
            var phoneEl = UI.$('phone');
            var submitEl = UI.$('submitBtn');
            if (!phoneEl || !submitEl) return;
            var phone = phoneEl.value.replace(/\D/g, '');
            var ready = State.currentSelection.slotKey &&
                        State.selectedServices.length > 0 &&
                        State.selectedSize &&
                        phone.length >= 11;
            submitEl.disabled = !ready;
        },

        submit: function() {
            var phone = UI.$('phone').value.trim();
            if (phone.replace(/\D/g, '').length < 11) { UI.toast('Введите корректный телефон', 'error'); return; }
            if (!State.currentSelection.slotKey) { UI.toast('Выберите слот', 'warning'); return; }
            if (State.selectedServices.length === 0) { UI.toast('Выберите услугу', 'warning'); return; }
            if (!State.selectedSize) { UI.toast('Выберите размер', 'warning'); return; }

            var payload = {
                branch: State.currentBranch,
                date: State.currentSelection.date,
                time: State.currentSelection.time,
                car: State.currentSelection.car,
                services: State.selectedServices.join(','),
                size: State.selectedSize,
                carBrand: UI.$('carBrand').value.trim().toUpperCase(),
                clientName: Utils.capitalizeName(UI.$('clientName').value.trim()),
                phone: phone,
                comment: UI.$('comment').value.trim(),
                rating: State.clientRating || 'neutral',
                notificationMethod: State.notificationMethod
            };
            var slotKey = Utils.normalizeSlotKey(
                payload.branch + '_' + payload.date + '_' + payload.time + '_' + payload.car
            );

            if (State.submitInFlight[slotKey]) {
                UI.toast('Уже отправляется...', 'warning', 1500);
                return;
            }
            var existing = State.occupiedSlots[slotKey];
            if (existing && !existing._optimistic) {
                UI.toast('Слот уже занят', 'error');
                NewRecord.renderSlots();
                return;
            }

            var now = Date.now();
            Object.keys(State.occupiedSlots).forEach(function(k) {
                var rec = State.occupiedSlots[k];
                if (rec._optimistic && (now - (rec._optimisticAt || 0)) > Config.OPTIMISTIC_TTL) {
                    delete State.occupiedSlots[k];
                }
            });

            State.submitInFlight[slotKey] = true;
            var submitBtn = UI.$('submitBtn');
            submitBtn.disabled = true;
            UI.setLoading('submitBtn', true, 'submitText', 'Запись...');

            State.occupiedSlots[slotKey] = {
                services: State.selectedServices.slice(),
                size: payload.size,
                carBrand: payload.carBrand,
                clientName: payload.clientName,
                phone: payload.phone,
                comment: payload.comment,
                extraComment: '',
                rating: payload.rating,
                notificationMethod: payload.notificationMethod,
                branch: payload.branch,
                _optimistic: true,
                _optimisticAt: now
            };
            App.addClientFromRecord(slotKey, State.occupiedSlots[slotKey]);
            NewRecord.renderSlots();
            App.updateStats();

            UI.toast('Клиент записан', 'success');
            NewRecord.resetForm();
            submitBtn.disabled = false;
            UI.setLoading('submitBtn', false);

            Api.createRecord(payload).then(function(res) {
                delete State.submitInFlight[slotKey];

                if (res === null) {
                    UI.toast('Сохранение в процессе...', 'info', 2500);
                    setTimeout(function() {
                        var rec = State.occupiedSlots[slotKey];
                        if (rec && rec._optimistic) {
                            App.bootstrap();
                        }
                    }, Config.VERIFY_DELAY);
                    return;
                }

                if (res.error) {
                    delete State.occupiedSlots[slotKey];
                    App.removeClientByKey(slotKey);
                    NewRecord.renderSlots();
                    Journal.invalidate();
                    Clients.invalidate();
                    Journal.render();
                    Clients.render();
                    App.updateStats();
                    UI.toast(res.error, 'error', 5000);
                    return;
                }

                if (res.ok && res.slotKey && res.record) {
                    if (res.slotKey !== slotKey) {
                        delete State.occupiedSlots[slotKey];
                        App.removeClientByKey(slotKey);
                    }
                    delete State.occupiedSlots[res.slotKey];
                    State.occupiedSlots[res.slotKey] = res.record;
                    App.addClientFromRecord(res.slotKey, res.record);
                    App.saveToCache();
                    NewRecord.renderSlots();
                    Journal.invalidate();
                    Clients.invalidate();
                    Journal.render();
                    Clients.render();
                    App.updateStats();
                    UI.toast('✓ Синхронизировано', 'success', 1200);
                } else {
                    App.bootstrap();
                }
            }).catch(function() {
                delete State.submitInFlight[slotKey];
                UI.toast('Сохранение в процессе...', 'info', 2500);
                setTimeout(function() {
                    var rec = State.occupiedSlots[slotKey];
                    if (rec && rec._optimistic) {
                        App.bootstrap();
                    }
                }, Config.VERIFY_DELAY);
            });
        },

        resetForm: function() {
            UI.$('phone').value = Config.PHONE_PREFIX;
            UI.$('clientName').value = '';
            UI.$('carBrand').value = '';
            UI.$('comment').value = '';
            State.selectedServices = [];
            State.selectedSize = '';
            State.clientRating = null;
            document.querySelectorAll('.service-btn, .size-btn').forEach(function(b) { b.classList.remove('selected'); });
            App.setRating(null);
            State.currentSelection = { date: null, time: null, car: null, slotKey: null };
            UI.$('autocompleteHint').classList.remove('show');
            App.hideCarsChips();
            UI.$('slotInfoBanner').classList.remove('show');
            NewRecord.renderServicesGrid();
        }
    };

    // ============================================================
    // 📋 RECORDS
    // ============================================================
    var Records = {
        openModal: function(slotKey) {
            slotKey = Utils.normalizeSlotKey(slotKey);
            var data = State.occupiedSlots[slotKey];
            if (!data) return;

            var parts = slotKey.split('_');
            var branch = parts[0], date = parts[1], time = parts[2];
            var branchName = branch === 'ryabinina' ? '🏠 Рябинина, 47/1' : '🏭 Амундсена 119/6';
            var services = Utils.parseServices(data.services);
            var rating = data.rating || 'neutral';
            var payment = data._payment;

            var modal = UI.$('recordModal');
            var content = UI.$('recordModalContent');
            content.className = 'modal-content ' + (rating === 'good' ? 'good' : rating === 'bad' ? 'bad' : '');

            var paymentHtml = '';
            if (payment && (payment.total > 0 || (payment.services && payment.services.length > 0))) {
                var paymentRows = (payment.services || []).map(function(s) {
                    var amt = Number(s.amount) || 0;
                    if (!amt) return '';
                    return '<div class="payment-service"><span>' + Utils.escapeHtml(s.name || '') + (s.payment ? ' · ' + Payments.label(s.payment) : '') + '</span><span class="price">' + Utils.fmtMoney(amt) + '</span></div>';
                }).join('');
                paymentHtml =
                    '<div class="record-payment-block">' +
                        '<div class="payment-title">💰 Оплата из Тетрадки</div>' +
                        paymentRows +
                        '<div class="payment-total"><span>Итого</span><span>' + Utils.fmtMoney(payment.total) + '</span></div>' +
                    '</div>';
            }

            content.innerHTML =
                '<div class="modal-header">' +
                    '<div class="modal-client-header">' +
                        '<div class="modal-avatar">' + Utils.escapeHtml((data.carBrand || '?').charAt(0).toUpperCase()) + '</div>' +
                        '<div class="modal-client-info">' +
                            '<h2>' + Utils.escapeHtml(data.carBrand || 'Без названия') + '</h2>' +
                            '<div class="phone">' + Utils.escapeHtml(data.clientName || 'Без имени') + ' · ' + Utils.escapeHtml(data.phone || '—') + '</div>' +
                        '</div>' +
                    '</div>' +
                    '<button class="close-modal-btn" data-close-modal="record">×</button>' +
                '</div>' +
                '<div class="record-detail-grid">' +
                    '<div class="record-detail-item"><div class="label">Филиал</div><div class="value small">' + branchName + '</div></div>' +
                    '<div class="record-detail-item"><div class="label">Дата · Время</div><div class="value">' + Utils.formatDate(date) + ' · ' + time + '</div></div>' +
                    '<div class="record-detail-item"><div class="label">Размер</div><div class="value">' + Utils.escapeHtml(data.size || '—') + '</div></div>' +
                    '<div class="record-detail-item"><div class="label">Уведомление</div><div class="value small">' +
                        (data.notificationMethod === 'whatsapp' ? '💬 WhatsApp' : data.notificationMethod === 'sms' ? '📱 SMS' : '—') +
                    '</div></div>' +
                    '<div class="record-detail-item" style="grid-column:1/-1"><div class="label">Услуги</div><div class="value small">' +
                        (services.length ? Utils.escapeHtml(services.join(', ')) : '—') +
                    '</div></div>' +
                    (data.comment ? '<div class="record-detail-item" style="grid-column:1/-1"><div class="label">Комментарий</div><div class="value small">' + Utils.escapeHtml(data.comment) + '</div></div>' : '') +
                '</div>' +
                paymentHtml +
                '<div class="modal-section-title">Репутация клиента</div>' +
                '<div class="record-rating-row">' +
                    '<button class="record-rating-btn good ' + (rating === 'good' ? 'active' : '') + '" id="recRatingGood">👍 Хороший</button>' +
                    '<button class="record-rating-btn bad ' + (rating === 'bad' ? 'active' : '') + '" id="recRatingBad">👎 Проблемный</button>' +
                '</div>' +
                '<div class="modal-section-title">Дополнительный комментарий</div>' +
                '<textarea id="recExtraComment" class="form-control" placeholder="Заметка мастера...">' + Utils.escapeHtml(data.extraComment || '') + '</textarea>' +
                '<div class="record-actions">' +
                    '<button class="btn danger delete-btn" id="deleteRecordBtn">🗑 Удалить</button>' +
                    '<button class="btn move-btn" id="openMoveBtn">⇄ Перенести</button>' +
                    '<button class="btn primary save-btn" id="saveRecordBtn">💾 Сохранить</button>' +
                '</div>';

            modal.classList.add('show');

            var newRating = (rating === 'good' || rating === 'bad') ? rating : null;
            var updUI = function() {
                UI.$('recRatingGood').classList.toggle('active', newRating === 'good');
                UI.$('recRatingBad').classList.toggle('active', newRating === 'bad');
            };
            UI.$('recRatingGood').addEventListener('click', function() { newRating = newRating === 'good' ? null : 'good'; updUI(); });
            UI.$('recRatingBad').addEventListener('click', function() { newRating = newRating === 'bad' ? null : 'bad'; updUI(); });

            UI.$('saveRecordBtn').addEventListener('click', function() {
                UI.setLoading('saveRecordBtn', true, null, 'Сохранение...');
                var extra = UI.$('recExtraComment').value.trim();
                var newRatingVal = newRating || 'neutral';

                Api.saveExtra(slotKey, extra, newRatingVal, data.phone || '').then(function(res) {
                    if (res && res.ok && res.slotKey && res.record) {
                        delete State.occupiedSlots[res.slotKey];
                        State.occupiedSlots[res.slotKey] = res.record;
                        App.addClientFromRecord(res.slotKey, res.record);
                        App.saveToCache();
                        NewRecord.renderSlots();
                        Journal.invalidate();
                        Clients.invalidate();
                        Journal.render();
                        Clients.render();
                        if (UI.$('page-tetradka').classList.contains('active')) Tetradka.renderAll();
                        UI.toast('Комментарий сохранён', 'success');
                    } else {
                        UI.toast('Ошибка сохранения', 'error');
                    }
                    UI.setLoading('saveRecordBtn', false);
                    setTimeout(function() { Records.closeModal(); }, 400);
                });
            });

            UI.$('deleteRecordBtn').addEventListener('click', function() {
                if (!confirm('Удалить запись?\n\n' + (data.carBrand || '') + ' · ' + (data.clientName || '') + '\n' + Utils.formatDate(date) + ' · ' + time)) return;
                UI.setLoading('deleteRecordBtn', true, null, 'Удаление...');
                Api.deleteRecord(slotKey).then(function(res) {
                    if (res && res.ok && res.slotKey) {
                        delete State.occupiedSlots[res.slotKey];
                        App.removeClientByKey(res.slotKey);
                        App.saveToCache();
                        NewRecord.renderSlots();
                        Journal.invalidate();
                        Clients.invalidate();
                        Journal.render();
                        Clients.render();
                        if (UI.$('page-tetradka').classList.contains('active')) Tetradka.renderAll();
                        UI.toast('Запись удалена', 'success');
                    } else {
                        UI.toast('Ошибка удаления', 'error');
                    }
                    Records.closeModal();
                });
            });

            UI.$('openMoveBtn').addEventListener('click', function() {
                Records.closeModal();
                Move.open(slotKey);
            });
        },

        closeModal: function() { UI.$('recordModal').classList.remove('show'); }
    };

    // ============================================================
    // ⇄ MOVE
    // ============================================================
    var Move = {
        open: function(slotKey) {
            var data = State.occupiedSlots[slotKey];
            if (!data) return;
            var parts = slotKey.split('_');

            var content = UI.$('moveModalContent');
            content.className = 'modal-content';
            content.innerHTML =
                '<div class="modal-header">' +
                    '<div><h2 style="font-size:18px;font-weight:700">Перенос записи</h2>' +
                    '<div style="font-size:13px;color:var(--text-2);margin-top:4px">' + Utils.escapeHtml(data.carBrand || '') + ' · ' + Utils.escapeHtml(data.clientName || '') + '</div></div>' +
                    '<button class="close-modal-btn" data-close-modal="move">×</button>' +
                '</div>' +
                '<div class="form-group"><label>Новая дата</label><input type="text" id="moveDatePicker" class="form-control" readonly></div>' +
                '<div class="form-group"><label>Свободные слоты</label><div class="move-slots-grid" id="moveSlotsGrid"></div></div>' +
                '<div class="record-actions"><button class="btn" data-close-modal="move">Отмена</button><button class="btn primary" id="confirmMoveBtn" disabled>⇄ Перенести</button></div>';

            UI.$('moveModal').classList.add('show');

            var ctx = { oldKey: slotKey, branch: parts[0], date: parts[1], time: parts[2], car: parts[3], selectedTime: null, selectedCar: null };

            flatpickr(UI.$('moveDatePicker'), {
                dateFormat: 'Y-m-d', defaultDate: parts[1], locale: 'ru',
                onChange: function(sd, ds) {
                    ctx.date = ds;
                    ctx.selectedTime = null;
                    ctx.selectedCar = null;
                    Move.renderSlots(ctx);
                }
            });

            Move.renderSlots(ctx);

            UI.$('confirmMoveBtn').addEventListener('click', function() {
                if (!ctx.selectedTime || !ctx.selectedCar) return;
                var newKey = Utils.normalizeSlotKey(ctx.branch + '_' + ctx.date + '_' + ctx.selectedTime + '_' + ctx.selectedCar);
                if (newKey === ctx.oldKey) { UI.toast('Тот же слот', 'warning'); return; }
                if (State.occupiedSlots[newKey]) { UI.toast('Слот занят', 'warning'); return; }
                UI.setLoading('confirmMoveBtn', true, null, 'Перенос...');
                Api.moveRecord(ctx.oldKey, newKey, {
                    branch: ctx.branch, date: ctx.date, time: ctx.selectedTime, car: ctx.selectedCar,
                    services: Utils.parseServices(data.services).join(','),
                    size: data.size || '', carBrand: data.carBrand || '',
                    clientName: data.clientName || '', phone: data.phone || '',
                    comment: data.comment || '', rating: data.rating || 'neutral',
                    notificationMethod: data.notificationMethod || 'whatsapp'
                }).then(function(res) {
                    UI.setLoading('confirmMoveBtn', false);
                    if (res && res.ok) {
                        delete State.occupiedSlots[res.oldKey];
                        delete State.occupiedSlots[res.newKey];
                        State.occupiedSlots[res.newKey] = res.record;
                        App.rebuildClients();
                        App.saveToCache();
                        NewRecord.renderSlots();
                        Journal.invalidate();
                        Clients.invalidate();
                        Journal.render();
                        Clients.render();
                        UI.toast('Запись перенесена', 'success');
                        Move.close();
                    } else {
                        UI.toast((res && res.error) || 'Ошибка переноса', 'error');
                    }
                });
            });
        },

        renderSlots: function(ctx) {
            var grid = UI.$('moveSlotsGrid');
            if (!grid) return;
            var slots = Utils.getTimeSlots(ctx.date);
            var currentKey = Utils.normalizeSlotKey(ctx.branch + '_' + ctx.date + '_' + ctx.time + '_' + ctx.car);

            var html = '';
            slots.forEach(function(time) {
                for (var i = 0; i < Config.CARS.length; i++) {
                    var car = Config.CARS[i];
                    var key = Utils.normalizeSlotKey(ctx.branch + '_' + ctx.date + '_' + time + '_' + car);
                    var busy = !!State.occupiedSlots[key];
                    var isCurrent = (key === currentKey);

                    var cls = 'move-slot-btn';
                    if (isCurrent) cls += ' current';
                    else if (busy) cls += ' busy';

                    var disabled = (busy && !isCurrent) ? 'disabled' : '';
                    html += '<button class="' + cls + '" data-time="' + time + '" data-car="' + car + '" ' + disabled + '>' +
                            time + ' · ' + car +
                            '</button>';
                }
            });
            grid.innerHTML = html;

            if (!grid._hasDelegatedClick) {
                grid.addEventListener('click', function(e) {
                    var btn = e.target.closest('.move-slot-btn:not([disabled])');
                    if (!btn) return;
                    grid.querySelectorAll('.move-slot-btn').forEach(function(b) { b.classList.remove('selected'); });
                    btn.classList.add('selected');
                    ctx.selectedTime = btn.dataset.time;
                    ctx.selectedCar = btn.dataset.car;
                    UI.$('confirmMoveBtn').disabled = false;
                });
                grid._hasDelegatedClick = true;
            }
        },

        close: function() { UI.$('moveModal').classList.remove('show'); }
    };

    // ============================================================
    // 📓 JOURNAL
    // ============================================================
    var Journal = {
        _lastRenderKey: '',
        invalidate: function() { Journal._lastRenderKey = ''; },
        render: function() {
            var q = UI.$('journalSearch').value.toLowerCase().trim();
            var currentKey = q + '|' + State.journalVersion;
            if (currentKey === Journal._lastRenderKey) return;
            Journal._lastRenderKey = currentKey;

            var entries = Object.keys(State.occupiedSlots).map(function(key) {
                var v = State.occupiedSlots[key];
                var parts = key.split('_');
                return Object.assign({ key: key, branch: parts[0], date: parts[1], time: parts[2], car: parts[3] }, v);
            }).sort(function(a, b) {
                return (String(b.date || '') + String(b.time || '')).localeCompare(String(a.date || '') + String(a.time || ''));
            });

            if (q) {
                entries = entries.filter(function(e) {
                    var svcs = Utils.parseServices(e.services).join(' ').toLowerCase();
                    return (e.clientName || '').toLowerCase().indexOf(q) !== -1 ||
                           (e.phone || '').indexOf(q) !== -1 ||
                           (e.carBrand || '').toLowerCase().indexOf(q) !== -1 ||
                           svcs.indexOf(q) !== -1 ||
                           (e.comment || '').toLowerCase().indexOf(q) !== -1 ||
                           (e.date || '').indexOf(q) !== -1 ||
                           (e.time || '').indexOf(q) !== -1;
                });
            }
            UI.$('journalCounter').textContent = entries.length + ' записей';

            var list = UI.$('journalList');
            if (entries.length === 0) {
                list.innerHTML = '<div class="empty-state"><span class="icon">▤</span><div class="text">' + (q ? 'Ничего не найдено' : 'Записей пока нет') + '</div></div>';
                return;
            }

            var html = '';
            entries.forEach(function(e) {
                var rating = e.rating || 'neutral';
                var cls = rating === 'good' ? 'good' : rating === 'bad' ? 'bad' : '';
                var phone = Utils.cleanPhone(e.phone || '');
                var client = State.clientsDatabase[phone];
                var ratingScore = client ? Utils.formatRating(client) : '—';
                var svcs = Utils.parseServices(e.services).join(', ') || '—';

                var paymentHtml = '';
                if (e._payment && (e._payment.total > 0 || (e._payment.services && e._payment.services.length > 0))) {
                    var servicesList = (e._payment.services || [])
                        .filter(function(s) { return Number(s.amount) > 0; })
                        .map(function(s) { return s.name + ' ' + Utils.fmtMoney(s.amount); })
                        .join(' · ');
                    paymentHtml = '<div class="record-payment-inline">' +
                        '<span class="services-list">💰 ' + Utils.escapeHtml(servicesList || 'оплата') + '</span>' +
                        '<span class="total">' + Utils.fmtMoney(e._payment.total) + '</span>' +
                    '</div>';
                }

                html += '<div class="record-item ' + cls + '" data-journal-key="' + e.key + '">' +
                    '<div class="record-header">' +
                        '<span>' + (e.branch === 'ryabinina' ? '🏠 Рябинина' : '🏭 Амундсена') + ' · ' + Utils.formatDate(e.date) + ' · ' + e.time + '</span>' +
                        '<span class="rating-num ' + rating + '">' + ratingScore + '</span>' +
                    '</div>' +
                    '<div class="record-body">' +
                        '<div><span>Авто</span>' + Utils.escapeHtml(e.carBrand || '—') + '</div>' +
                        '<div><span>Клиент</span>' + Utils.escapeHtml(e.clientName || '—') + '</div>' +
                        '<div><span>Телефон</span>' + Utils.escapeHtml(e.phone || '—') + '</div>' +
                        '<div><span>Услуги</span>' + Utils.escapeHtml(svcs) + ' ' + Utils.escapeHtml(e.size || '') + '</div>' +
                        (e.comment ? '<div style="grid-column:1/-1"><span>Комментарий</span>' + Utils.escapeHtml(e.comment) + '</div>' : '') +
                        (e.extraComment ? '<div style="grid-column:1/-1"><span style="color:var(--warning)">Доп. комментарий</span>' + Utils.escapeHtml(e.extraComment) + '</div>' : '') +
                        paymentHtml +
                    '</div>' +
                '</div>';
            });
            list.innerHTML = html;

            if (!list._hasDelegatedClick) {
                list.addEventListener('click', function(ev) {
                    var item = ev.target.closest('[data-journal-key]');
                    if (!item) return;
                    var key = item.dataset.journalKey;
                    if (key) Records.openModal(key);
                });
                list._hasDelegatedClick = true;
            }
        }
    };

    // ============================================================
    // 👥 CLIENTS
    // ============================================================
    var Clients = {
        _lastRenderKey: '',
        invalidate: function() { Clients._lastRenderKey = ''; },
        render: function() {
            var q = UI.$('clientSearch').value.toLowerCase().trim();
            var currentKey = q + '|' + State.clientsVersion;
            if (currentKey === Clients._lastRenderKey) return;
            Clients._lastRenderKey = currentKey;

            var clients = Object.keys(State.clientsDatabase).map(function(k) { return State.clientsDatabase[k]; });
            if (q) {
                clients = clients.filter(function(c) {
                    return (c.name || '').toLowerCase().indexOf(q) !== -1 ||
                           (c.phone || '').indexOf(q) !== -1 ||
                           Object.keys(c.cars).some(function(b) { return b.toLowerCase().indexOf(q) !== -1; });
                });
            }
            clients.sort(function(a, b) {
                var order = { bad: 0, good: 1, neutral: 2 };
                var da = order[a.rating] !== undefined ? order[a.rating] : 2;
                var db = order[b.rating] !== undefined ? order[b.rating] : 2;
                var d = da - db;
                return d !== 0 ? d : (b.visits || 0) - (a.visits || 0);
            });

            UI.$('clientsCounter').textContent = clients.length + ' клиентов';

            var list = UI.$('clientsList');
            if (clients.length === 0) {
                list.innerHTML = '<div class="empty-state"><span class="icon">◉</span><div class="text">' + (q ? 'Ничего не найдено' : 'Клиентов пока нет') + '</div></div>';
                UI.$('clientsBadge').textContent = 0;
                return;
            }

            var html = '';
            clients.forEach(function(c) {
                var initial = (c.name || '?').charAt(0).toUpperCase();
                var cars = Object.keys(c.cars).map(function(b) {
                    var n = c.cars[b];
                    return '<span class="client-car-tag">' + Utils.escapeHtml(b) + (n > 1 ? ' ×' + n : '') + '</span>';
                }).join('');
                var phone = Utils.cleanPhone(c.phone);
                var ratingScore = Utils.formatRating(c);

                html += '<div class="client-card ' + c.rating + '" data-client-phone="' + phone + '">' +
                    '<div class="client-avatar">' + Utils.escapeHtml(initial) + '</div>' +
                    '<div class="client-info">' +
                        '<div class="name">' + Utils.escapeHtml(c.name || 'Без имени') + '</div>' +
                        '<div class="phone">' + Utils.escapeHtml(c.phone || '—') + '</div>' +
                    '</div>' +
                    '<div class="client-cars-mini">' + cars + '</div>' +
                    '<div class="client-stats-mini"><div class="visits-count">' + c.visits + '<small>визитов</small></div></div>' +
                    '<div class="client-rating-num">' + ratingScore + '</div>' +
                '</div>';
            });
            list.innerHTML = html;
            UI.$('clientsBadge').textContent = Object.keys(State.clientsDatabase).length;

            if (!list._hasDelegatedClick) {
                list.addEventListener('click', function(ev) {
                    var card = ev.target.closest('[data-client-phone]');
                    if (!card) return;
                    var phone = card.dataset.clientPhone;
                    if (phone) Clients.openModal(phone);
                });
                list._hasDelegatedClick = true;
            }
        },

        openModal: function(phone) {
            var client = State.clientsDatabase[phone];
            if (!client) return;
            var initial = (client.name || '?').charAt(0).toUpperCase();
            var ratio = Utils.calcRating(client);
            var stars = '★'.repeat(Math.round(ratio)) + '☆'.repeat(5 - Math.round(ratio));

            var cars = Object.keys(client.cars).map(function(brand) {
                var count = client.cars[brand];
                return '<div class="modal-car-item"><div class="brand">' + Utils.escapeHtml(brand) + '</div>' +
                    '<div class="count">' + count + ' ' + (count === 1 ? 'визит' : 'визитов') + '</div></div>';
            }).join('');

            var history = client.history.slice(0, 30).map(function(h) {
                var svcs = Utils.parseServices(h.services).join(', ') || '—';
                var safeKey = Utils.escapeHtml(h.key || '');
                return '<div class="modal-history-item" data-record-key="' + safeKey + '">' +
                    '<div class="date">' + Utils.formatDate(h.date) + ' ' + h.time + '</div>' +
                    '<div class="services">' + Utils.escapeHtml(svcs) + ' ' + Utils.escapeHtml(h.size || '') + '</div>' +
                    '<div class="branch-tag">' + (h.branch === 'ryabinina' ? 'Ряб.' : 'Амунд.') + '</div></div>';
            }).join('');

            var content = UI.$('clientModalContent');
            content.className = 'modal-content ' + (client.rating === 'good' ? 'good' : client.rating === 'bad' ? 'bad' : '');
            content.innerHTML =
                '<div class="modal-header">' +
                    '<div class="modal-client-header">' +
                        '<div class="modal-avatar">' + Utils.escapeHtml(initial) + '</div>' +
                        '<div class="modal-client-info"><h2>' + Utils.escapeHtml(client.name || 'Без имени') + '</h2><div class="phone">' + Utils.escapeHtml(client.phone || '—') + '</div></div>' +
                    '</div>' +
                    '<button class="close-modal-btn" data-close-modal="client">×</button>' +
                '</div>' +
                '<div class="modal-stats-grid">' +
                    '<div class="modal-stat"><div class="modal-stat-value">' + client.visits + '</div><div class="modal-stat-label">Визитов</div></div>' +
                    '<div class="modal-stat"><div class="modal-stat-value good">' + client.goodCount + '</div><div class="modal-stat-label">Хороших</div></div>' +
                    '<div class="modal-stat"><div class="modal-stat-value bad">' + client.badCount + '</div><div class="modal-stat-label">Проблемных</div></div>' +
                '</div>' +
                '<div class="modal-section-title">Оценка клиента</div>' +
                '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">' +
                    '<div style="font-size:24px;color:var(--warning);letter-spacing:-2px">' + stars + '</div>' +
                    '<div style="font-size:13px;color:var(--text-2)">' + ratio.toFixed(1) + ' из 5.0</div>' +
                '</div>' +
                '<div class="modal-section-title">Изменить рейтинг</div>' +
                '<div class="record-rating-row" style="margin-bottom:20px">' +
                    '<button class="record-rating-btn good ' + (client.rating === 'good' ? 'active' : '') + '" id="clientRatingGood">👍 Хороший</button>' +
                    '<button class="record-rating-btn bad ' + (client.rating === 'bad' ? 'active' : '') + '" id="clientRatingBad">👎 Проблемный</button>' +
                '</div>' +
                '<div class="modal-section-title">Машины клиента (' + Object.keys(client.cars).length + ')</div>' +
                '<div class="modal-cars-list">' + (cars || '<div style="color:var(--text-2);font-size:12px">Нет данных</div>') + '</div>' +
                '<div class="modal-section-title">История визитов</div>' +
                '<div class="modal-history-list">' + (history || '<div style="color:var(--text-2);font-size:12px">Нет записей</div>') + '</div>';
            UI.$('clientModal').classList.add('show');

            content.querySelectorAll('.modal-history-item').forEach(function(item) {
                item.addEventListener('click', function() {
                    var key = this.dataset.recordKey;
                    if (!key) return;
                    Clients.closeModal();
                    setTimeout(function() { Records.openModal(key); }, 150);
                });
            });

            var newRating = (client.rating === 'good' || client.rating === 'bad') ? client.rating : null;
            var updUI = function() {
                UI.$('clientRatingGood').classList.toggle('active', newRating === 'good');
                UI.$('clientRatingBad').classList.toggle('active', newRating === 'bad');
            };
            UI.$('clientRatingGood').addEventListener('click', function() {
                newRating = newRating === 'good' ? null : 'good';
                updUI();
                Clients.saveRating(phone, newRating);
            });
            UI.$('clientRatingBad').addEventListener('click', function() {
                newRating = newRating === 'bad' ? null : 'bad';
                updUI();
                Clients.saveRating(phone, newRating);
            });
        },

        saveRating: function(phone, rating) {
            var target = rating || 'neutral';
            var keys = [];
            Object.keys(State.occupiedSlots).forEach(function(k) {
                var rec = State.occupiedSlots[k];
                if (rec && Utils.cleanPhone(rec.phone) === phone) keys.push(k);
            });
            if (keys.length === 0) { UI.toast('Нет записей клиента', 'warning'); return; }

            keys.forEach(function(k) { State.occupiedSlots[k].rating = target; });
            App.rebuildClients();
            Clients.invalidate();
            Clients.render();

            Api.saveExtraBatch(keys, undefined, target).then(function(res) {
                if (res && res.ok && res.updated) {
                    var updated = res.updated;
                    Object.keys(updated).forEach(function(k) {
                        State.occupiedSlots[k] = updated[k];
                    });
                    App.rebuildClients();
                    App.saveToCache();
                    Clients.invalidate();
                    Clients.render();
                    NewRecord.renderSlots();
                    Journal.invalidate();
                    Journal.render();
                    if (UI.$('page-tetradka').classList.contains('active')) Tetradka.renderAll();
                    UI.toast('Рейтинг обновлён', 'success');
                } else {
                    App.bootstrap();
                    UI.toast('Ошибка обновления', 'error');
                }
            }).catch(function() {
                App.bootstrap();
                UI.toast('Ошибка обновления', 'error');
            });
        },

        closeModal: function() { UI.$('clientModal').classList.remove('show'); }
    };

    // ============================================================
    // 💰 PRICES
    // ============================================================
    var Prices = {
        get: function(branch) { return State.prices[branch] || null; },
        loadFromServer: function(force) {
            if (!force && State.pricesLoaded && State.prices.ryabinina) {
                Prices.render();
                return Promise.resolve();
            }
            UI.$('priceContent').innerHTML = '<div class="empty-price"><span class="icon">⏳</span><div class="text">Загрузка прайса...</div></div>';
            return Api.getPrices().then(function(data) {
                if (data && !data.error) {
                    State.prices = {
                        ryabinina: data.ryabinina || null,
                        amundsena: data.amundsena || null
                    };
                    State.pricesLoaded = true;
                    App.saveToCache();
                } else if (!State.prices.ryabinina) {
                    UI.toast('Не удалось загрузить прайс', 'error');
                }
                Prices.render();
            });
        },
        render: function() {
            var data = Prices.get(State.priceBranch);
            var content = UI.$('priceContent');
            if (!data || !data.categories || data.categories.length === 0) {
                content.innerHTML = '<div class="empty-price"><span class="icon">💰</span><div class="text">Прайс пуст</div><div class="hint">Проверьте лист <b>Prices</b></div></div>';
                return;
            }
            var sizesToShow = Config.SIZES;
            var html = '';
            var mobileHtml = '';
            data.categories.forEach(function(cat) {
                html += '<div class="price-category">';
                html += '<div class="price-category-title"><span class="category-icon">' + Utils.escapeHtml(cat.icon || '📋') + '</span><span>' + Utils.escapeHtml(cat.title) + '</span></div>';
                html += '<div class="price-table-wrap"><div class="price-table">';
                html += '<div class="price-row price-header"><div class="service-name">Услуга</div>';
                sizesToShow.forEach(function(s) { html += '<div style="text-align:center">' + s + '</div>'; });
                html += '</div>';
                cat.services.forEach(function(srv) {
                    html += '<div class="price-row"><div class="service-name">' + Utils.escapeHtml(srv.name) + '</div>';
                    sizesToShow.forEach(function(s) {
                        var formatted = Utils.formatPrice(srv.prices[s]);
                        if (formatted === null) html += '<div class="price-cell empty">—</div>';
                        else {
                            var isMulti = String(srv.prices[s]).indexOf('/') !== -1;
                            html += '<div class="price-cell' + (isMulti ? ' multi' : '') + '">' + Utils.escapeHtml(formatted) + '</div>';
                        }
                    });
                    html += '</div>';
                });
                html += '</div></div>';
                if (!Utils.isJunkExtraInfo(cat.extraInfo)) html += '<div class="cat-extra-info">' + Utils.escapeHtml(cat.extraInfo) + '</div>';
                html += '</div>';

                mobileHtml += '<div class="price-mobile-cat"><div class="price-mobile-cat-title"><span class="category-icon">' + Utils.escapeHtml(cat.icon || '📋') + '</span><span>' + Utils.escapeHtml(cat.title) + '</span></div>';
                cat.services.forEach(function(srv) {
                    var chips = [];
                    sizesToShow.forEach(function(s) {
                        var formatted = Utils.formatPrice(srv.prices[s]);
                        if (formatted === null) return;
                        var isMulti = String(srv.prices[s]).indexOf('/') !== -1;
                        chips.push('<div class="price-mobile-chip' + (isMulti ? ' multi' : '') + '"><span class="size">' + s + '</span><span class="price">' + Utils.escapeHtml(formatted) + '</span></div>');
                    });
                    if (chips.length === 0) return;
                    mobileHtml += '<div class="price-mobile-item"><div class="name">' + Utils.escapeHtml(srv.name) + '</div><div class="price-mobile-prices">' + chips.join('') + '</div></div>';
                });
                if (!Utils.isJunkExtraInfo(cat.extraInfo)) mobileHtml += '<div class="cat-extra-info">' + Utils.escapeHtml(cat.extraInfo) + '</div>';
                mobileHtml += '</div>';
            });
            content.innerHTML = html + '<div class="price-mobile">' + mobileHtml + '</div>';
        }
    };

    // ============================================================
    // 📓 ТЕТРАДКА
    // ============================================================
    var Tetradka = {
        _autoSaveTimer: null,
        _hasChanges: false,
        _lastSavedAt: null,
        _isSaving: false,
        _refreshingRecords: false,
        _refreshingFull: false,

        init: function() {
            flatpickr(UI.$('tetradkaDatePicker'), {
                dateFormat: 'Y-m-d', defaultDate: new Date(), locale: 'ru',
                onChange: function(sd, ds) {
                    if (Tetradka._hasChanges) {
                        Tetradka.autoSave().then(function(ok) {
                            if (ok === false) {
                                UI.toast('Не удалось сохранить — переключение отменено', 'error', 4000);
                                return;
                            }
                            State.tetradkaDate = ds;
                            State.tetradkaLoaded[State.tetradkaBranch] = false;
                            State.carsHideCount = 0;
                            Tetradka.loadDay();
                        });
                    } else {
                        State.tetradkaDate = ds;
                        State.tetradkaLoaded[State.tetradkaBranch] = false;
                        State.carsHideCount = 0;
                        Tetradka.loadDay();
                    }
                }
            });

            document.querySelectorAll('.tetradka-branch').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var doSwitch = function() {
                        document.querySelectorAll('.tetradka-branch').forEach(function(b) { b.classList.remove('active'); });
                        btn.classList.add('active');
                        State.tetradkaBranch = btn.dataset.branch;
                        State.carsHideCount = 0;
                        Tetradka.loadDay();
                    };
                    if (Tetradka._hasChanges) Tetradka.autoSave().then(function(ok) {
                        if (ok === false) {
                            UI.toast('Не удалось сохранить — переключение отменено', 'error', 4000);
                            return;
                        }
                        doSwitch();
                    });
                    else doSwitch();
                });
            });

            UI.$('toggleProcessedRecords').addEventListener('click', function() {
                State.hideProcessedRecords = !State.hideProcessedRecords;
                this.textContent = State.hideProcessedRecords ? '👁 Показать обработанные' : '👁 Скрыть обработанные';
                this.classList.toggle('primary', State.hideProcessedRecords);
                var d = Tetradka.getCurrent();
                if (d) Tetradka.renderRecords(d);
            });

            UI.$('refreshRecordsBtn').addEventListener('click', function() {
                Tetradka.refreshRecordsOnly(this);
            });

            UI.$('refreshTetradkaBtn').addEventListener('click', function() {
                Tetradka.fullRefresh(this);
            });

            UI.$('applyHideCarsBtn').addEventListener('click', function() {
                var val = parseInt(UI.$('carsHideInput').value, 10);
                if (isNaN(val) || val < 0) val = 0;
                var d = Tetradka.getCurrent();
                if (!d) return;
                if (val > d.cars.length) val = d.cars.length;
                State.carsHideCount = val;
                Tetradka.renderCars(d);
            });

            UI.$('showAllCarsBtn').addEventListener('click', function() {
                State.carsHideCount = 0;
                UI.$('carsHideInput').value = 0;
                var d = Tetradka.getCurrent();
                if (d) Tetradka.renderCars(d);
            });

            UI.$('addServiceBtn').addEventListener('click', function() {
                var d = Tetradka.getCurrent();
                if (!d) return;
                d.services.push({ name: 'новая услуга', percents: {}, fixed: false });
                Tetradka.markDirty();
                Tetradka.renderAll();
            });

            UI.$('addCarBtn').addEventListener('click', function() {
                var d = Tetradka.getCurrent();
                if (!d) return;
                d.cars.push({
                    id: 'car_' + Date.now(), car: '', recordKey: null, payment: '', total: 0,
                    services: [{ name: 'шиномонтаж', amount: 0, payment: '' }], recordStatus: ''
                });
                Tetradka.markDirty();
                Tetradka.renderAll();
            });

            UI.$('addAdvanceBtn').addEventListener('click', function() {
                var d = Tetradka.getCurrent();
                if (!d) return;
                d.advances.push({
                    id: 'adv_' + Date.now(),
                    master: (State.mastersList[0] ? State.mastersList[0].name : ''),
                    amount: 0, comment: '', payment: 'cash'
                });
                Tetradka.markDirty();
                Tetradka.renderAdvances(d);
                Tetradka.renderCash(d);
            });

            UI.$('addExpenseBtn').addEventListener('click', function() {
                var d = Tetradka.getCurrent();
                if (!d) return;
                d.cash.expenses.push({ id: 'exp_' + Date.now(), description: '', amount: 0 });
                Tetradka.markDirty();
                Tetradka.renderExpenses(d);
                Tetradka.renderCash(d);
            });

            UI.$('cashStart').addEventListener('input', function() {
                var d = Tetradka.getCurrent();
                if (d) {
                    d.cash.start_cash = Number(this.value) || 0;
                    Tetradka.markDirty();
                    Tetradka.updateCashDisplay(d);
                }
            });

            UI.$('saveTetradkaBtn').addEventListener('click', Tetradka.manualSave);

            window.addEventListener('beforeunload', function() {
                if (Tetradka._hasChanges && !State.tetradkaLoadFailed) {
                    var d = Tetradka.getCurrent();
                    if (d) {
                        var mastersData = [];
                        d.services.forEach(function(svc) {
                            Object.keys(svc.percents).forEach(function(master) {
                                if (!d.mastersOnShift[master]) return;
                                if (!svc.name || svc.name === 'undefined') return;
                                mastersData.push({ master: master, service: svc.name, percent: svc.percents[master] });
                            });
                        });
                        var params = new URLSearchParams({
                            action: 'saveSalaryDay', date: d.date, branch: d.branch,
                            masters: JSON.stringify(mastersData),
                            cars: JSON.stringify(d.cars.map(function(c) {
                                return {
                                    id: c.id, car: c.car, recordKey: c.recordKey || '',
                                    payment: c.payment || '',
                                    total: c.services.reduce(function(s, x) { return s + (Number(x.amount) || 0); }, 0),
                                    services: c.services, recordStatus: c.recordStatus || ''
                                };
                            })),
                            cash: JSON.stringify(d.cash),
                            advances: JSON.stringify(d.advances),
                            pump: JSON.stringify(d.pump)
                        });
                        try { navigator.sendBeacon(Config.APPS_SCRIPT_URL, params); } catch (e) {}
                    }
                }
            });

            setInterval(function() { Tetradka.updateSaveStatus(); }, 10000);
        },

        refreshRecordsOnly: function(btn) {
            if (Tetradka._refreshingRecords) return;
            var d = Tetradka.getCurrent();
            if (!d) return;
            Tetradka._refreshingRecords = true;
            var originalText = btn.textContent;
            btn.textContent = '⏳';
            btn.disabled = true;

            Api.getSalaryDay(d.date, d.branch).then(function(res) {
                if (res && !res.error) {
                    var savedCars = d.cars;
                    var savedAdvances = d.advances;
                    var savedCash = d.cash;
                    var savedMastersOnShift = d.mastersOnShift;
                    var savedServices = d.services;
                    var savedPump = d.pump;

                    Tetradka.applyServerData(d.branch, d.date, res);

                    var newD = State.tetradka[d.branch];
                    if (newD) {
                        newD.cars = savedCars;
                        newD.advances = savedAdvances;
                        newD.cash = savedCash;
                        newD.mastersOnShift = savedMastersOnShift;
                        newD.services = savedServices;
                        if (savedPump) newD.pump = savedPump;
                        newD.records = Tetradka.getRecordsForDate(d.date, d.branch);
                        var freshCars = (res.cars || []);
                        newD.records.forEach(function(rec) {
                            var linked = freshCars.find(function(c) { return c.recordKey === rec.key; });
                            if (linked && linked.recordStatus) rec.status = linked.recordStatus;
                        });
                    }
                    Tetradka.renderAll();
                    UI.toast('Записи обновлены', 'success', 1500);
                } else {
                    UI.toast('Не удалось обновить', 'error');
                }
                Tetradka._refreshingRecords = false;
                btn.textContent = originalText;
                btn.disabled = false;
            }).catch(function() {
                Tetradka._refreshingRecords = false;
                btn.textContent = originalText;
                btn.disabled = false;
                UI.toast('Ошибка обновления', 'error');
            });
        },

        fullRefresh: function(btn) {
            if (Tetradka._refreshingFull) return;
            Tetradka._refreshingFull = true;
            var originalText = btn ? btn.textContent : '';
            if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

            var d = Tetradka.getCurrent();
            if (!d) {
                Tetradka._refreshingFull = false;
                if (btn) { btn.textContent = originalText; btn.disabled = false; }
                return;
            }

            var doLoad = function() {
                State.tetradkaLoaded[State.tetradkaBranch] = false;
                State.tetradkaLoadFailed = false;
                Api.getSalaryDay(d.date, d.branch).then(function(res) {
                    if (res && !res.error) {
                        State.tetradkaLoadFailed = false;
                        Tetradka.applyServerData(d.branch, d.date, res);
                        State.tetradkaLoaded[d.branch] = true;
                        Tetradka._lastSavedAt = new Date();
                        Tetradka._hasChanges = false;
                        Tetradka.updateSaveStatus('saved');
                        Tetradka.renderAll();
                        UI.toast('Данные обновлены', 'success', 1500);
                    } else {
                        State.tetradkaLoadFailed = true;
                        UI.toast('Не удалось обновить', 'error');
                    }
                    Tetradka._refreshingFull = false;
                    if (btn) { btn.textContent = originalText; btn.disabled = false; }
                }).catch(function() {
                    State.tetradkaLoadFailed = true;
                    Tetradka._refreshingFull = false;
                    if (btn) { btn.textContent = originalText; btn.disabled = false; }
                    UI.toast('Ошибка обновления', 'error');
                });
            };

            if (Tetradka._hasChanges && !State.tetradkaLoadFailed) {
                Tetradka.autoSave().then(doLoad);
            } else {
                doLoad();
            }
        },

        getCurrent: function() { return State.tetradka[State.tetradkaBranch]; },
        markDirty: function() {
            Tetradka._hasChanges = true;
            Tetradka.updateSaveStatus();
            Tetradka.scheduleAutoSave();
        },
        scheduleAutoSave: function() {
            if (Tetradka._autoSaveTimer) clearTimeout(Tetradka._autoSaveTimer);
            Tetradka._autoSaveTimer = setTimeout(function() { Tetradka.autoSave(); }, Config.AUTOSAVE_INTERVAL);
        },

        autoSave: function() {
            if (!Tetradka._hasChanges) return Promise.resolve(true);
            if (Tetradka._isSaving) return Promise.resolve(false);
            if (State.tetradkaLoadFailed) {
                Tetradka.updateSaveStatus('error');
                return Promise.resolve(false);
            }
            var d = Tetradka.getCurrent();
            if (!d) return Promise.resolve(false);
            var hasData = d.cars.length > 0 || d.advances.length > 0 ||
                          (d.cash.expenses && d.cash.expenses.length > 0) ||
                          (d.cash.start_cash && d.cash.start_cash > 0) ||
                          (d.pump && (d.pump.bn || d.pump.cash || d.pump.card || d.pump.sbp)) ||
                          d.services.some(function(s) { return Object.keys(s.percents).length > 0; }) ||
                          (d.mastersOnShift && Object.keys(d.mastersOnShift).length > 0);
            if (!hasData) return Promise.resolve(true);
            Tetradka._isSaving = true;
            Tetradka.updateSaveStatus('saving');
            return Tetradka.saveInternal().then(function(ok) {
                Tetradka._isSaving = false;
                if (ok) {
                    Tetradka._hasChanges = false;
                    Tetradka._lastSavedAt = new Date();
                    Tetradka.updateSaveStatus('saved');
                } else {
                    Tetradka.updateSaveStatus('error');
                }
                return ok;
            });
        },

        manualSave: function() {
            var d = Tetradka.getCurrent();
            if (!d) return;
            if (State.tetradkaLoadFailed) {
                UI.toast('Сначала загрузите данные дня (↻ Обновить)', 'error', 4000);
                return;
            }
            if (!confirm('Закрыть смену?\n\nВсе данные будут сохранены. Продолжить?')) return;
            UI.setLoading('saveTetradkaBtn', true, null, 'Сохранение...');
            Tetradka._isSaving = true;
            Tetradka.updateSaveStatus('saving');
            Tetradka.saveInternal().then(function(ok) {
                UI.setLoading('saveTetradkaBtn', false);
                Tetradka._isSaving = false;
                if (ok) {
                    Tetradka._hasChanges = false;
                    Tetradka._lastSavedAt = new Date();
                    Tetradka.updateSaveStatus('saved');
                    UI.toast('✓ Смена закрыта. Данные сохранены.', 'success');
                } else {
                    Tetradka.updateSaveStatus('error');
                    UI.toast('Ошибка сохранения', 'error');
                }
            });
        },

        saveInternal: function() {
            if (State.tetradkaLoadFailed) {
                return Promise.resolve(false);
            }
            var d = Tetradka.getCurrent();
            if (!d) return Promise.resolve(false);
            var mastersData = [];
            d.services.forEach(function(svc) {
                if (!svc.name || svc.name === 'undefined') return;
                Object.keys(svc.percents).forEach(function(master) {
                    if (!d.mastersOnShift[master]) return;
                    mastersData.push({ master: master, service: svc.name, percent: svc.percents[master] });
                });
            });
            return Api.saveSalaryDay({
                date: d.date, branch: d.branch,
                masters: JSON.stringify(mastersData),
                cars: JSON.stringify(d.cars.map(function(c) {
                    return {
                        id: c.id, car: c.car, recordKey: c.recordKey || '',
                        payment: c.payment || '',
                        total: c.services.reduce(function(s, x) { return s + (Number(x.amount) || 0); }, 0),
                        services: c.services, recordStatus: c.recordStatus || ''
                    };
                })),
                cash: JSON.stringify(d.cash),
                advances: JSON.stringify(d.advances),
                pump: JSON.stringify(d.pump)
            }).then(function(res) { return !!(res && !res.error); }).catch(function() { return false; });
        },

        updateSaveStatus: function(forceState) {
            var el = UI.$('saveStatus'), txt = UI.$('saveStatusText');
            if (!el || !txt) return;
            el.classList.remove('saving', 'saved', 'dirty', 'error');
            var state = forceState;
            if (!state) {
                if (State.tetradkaLoadFailed) state = 'error';
                else if (Tetradka._isSaving) state = 'saving';
                else if (Tetradka._hasChanges) state = 'dirty';
                else if (Tetradka._lastSavedAt) state = 'saved';
                else state = 'saved';
            }
            el.classList.add(state);
            if (state === 'saving') txt.textContent = 'Сохранение...';
            else if (state === 'dirty') txt.textContent = 'Есть изменения';
            else if (state === 'error') txt.textContent = State.tetradkaLoadFailed ? 'Не загружено' : 'Ошибка';
            else {
                if (Tetradka._lastSavedAt) {
                    var sec = Math.floor((Date.now() - Tetradka._lastSavedAt.getTime()) / 1000);
                    if (sec < 5) txt.textContent = 'Сохранено';
                    else if (sec < 60) txt.textContent = 'Сохранено ' + sec + ' сек назад';
                    else if (sec < 3600) txt.textContent = 'Сохранено ' + Math.floor(sec / 60) + ' мин назад';
                    else txt.textContent = 'Сохранено';
                } else txt.textContent = '—';
            }
        },

        loadDay: function(force) {
            var date = State.tetradkaDate;
            var branch = State.tetradkaBranch;
            if (!date) return;
            if (!force && State.tetradkaLoaded[branch] && State.tetradka[branch] && State.tetradka[branch].date === date) {
                Tetradka.renderAll();
                return;
            }
            if (!State.tetradka[branch]) {
                UI.$('carsList').innerHTML = '<div class="skeleton" style="height:80px"></div>';
            }
            Api.getSalaryDay(date, branch).then(function(res) {
                if (!res || res.error) {
                    State.tetradkaLoadFailed = true;
                    var d = State.tetradka[branch];
                    if (d && d.date === date) {
                        Tetradka._hasChanges = false;
                        Tetradka.updateSaveStatus('error');
                        Tetradka.renderAll();
                    } else {
                        UI.$('carsList').innerHTML = '<div class="cash-empty" style="padding:20px;text-align:center">' +
                            '⚠️ Не удалось загрузить день<br><br>' +
                            '<button class="btn primary" onclick="Tetradka.fullRefresh()">↻ Повторить</button>' +
                            '</div>';
                    }
                    UI.toast('Не удалось загрузить данные дня. Нажмите ↻ Обновить', 'error', 6000);
                    return;
                }
                State.tetradkaLoadFailed = false;
                Tetradka.applyServerData(branch, date, res);
                State.tetradkaLoaded[branch] = true;
                Tetradka._lastSavedAt = new Date();
                Tetradka._hasChanges = false;
                Tetradka.updateSaveStatus('saved');
                Tetradka.renderAll();
            });
        },

        emptyDay: function(date, branch) {
            return {
                date: date, branch: branch,
                masters: State.mastersList.slice(),
                mastersOnShift: {},
                services: [
                    { name: 'шиномонтаж', percents: {}, fixed: true, order: 0 },
                    { name: 'подкачка', percents: {}, fixed: true, order: 1 }
                ],
                cars: [],
                records: Tetradka.getRecordsForDate(date, branch),
                cash: { start_cash: 0, expenses: [] },
                advances: [],
                pump: { bn: 0, cash: 0, card: 0, sbp: 0 }
            };
        },

        applyServerData: function(branch, date, res) {
            var servicesMap = {};
            servicesMap['шиномонтаж'] = { name: 'шиномонтаж', percents: {}, fixed: true, order: 0 };
            servicesMap['подкачка'] = { name: 'подкачка', percents: {}, fixed: true, order: 1 };
            var mastersOnShift = {};

            var existing = State.tetradka[branch];
            if (existing && existing.date === date && existing.mastersOnShift) {
                Object.keys(existing.mastersOnShift).forEach(function(k) {
                    if (existing.mastersOnShift[k]) mastersOnShift[k] = true;
                });
                if (existing.services && existing.services.length) {
                    existing.services.forEach(function(svc) {
                        if (!svc || !svc.name || svc.name === 'undefined') return;
                        if (svc.fixed) return;
                        servicesMap[svc.name] = {
                            name: svc.name, percents: Object.assign({}, svc.percents || {}),
                            fixed: false, order: svc.order !== undefined ? svc.order : 100
                        };
                    });
                }
            }

            (res.masters || []).forEach(function(m) {
                var svcName = String(m.service || '').trim();
                if (!svcName || svcName === 'undefined' || svcName === 'null') return;
                var masterName = String(m.master || '').trim();
                if (!masterName) return;
                if (!servicesMap[svcName]) {
                    servicesMap[svcName] = { name: svcName, percents: {}, fixed: false, order: 100 };
                }
                servicesMap[svcName].percents[masterName] = Number(m.percent) || 0;
                mastersOnShift[masterName] = true;
            });

            var cars = (res.cars || []).map(function(c) {
                var total = (c.services || []).reduce(function(s, x) { return s + (Number(x.amount) || 0); }, 0);
                return {
                    id: c.id || ('car_' + Date.now()),
                    car: c.car || '', recordKey: c.recordKey || null,
                    payment: c.payment || '', total: total,
                    services: (c.services || []).map(function(s) {
                        return { name: s.name || '', amount: Number(s.amount) || 0, payment: s.payment || '' };
                    }),
                    recordStatus: c.recordStatus || ''
                };
            });

            var recs = Tetradka.getRecordsForDate(date, branch);
            recs.forEach(function(rec) {
                var linkedCar = cars.find(function(c) { return c.recordKey === rec.key; });
                if (linkedCar && linkedCar.recordStatus) {
                    rec.status = linkedCar.recordStatus;
                    rec.linkedCarId = linkedCar.id;
                }
            });

            var servicesList = Object.keys(servicesMap)
                .map(function(k) { return servicesMap[k]; })
                .filter(function(s) { return s && s.name && s.name !== 'undefined'; })
                .sort(function(a, b) {
                    if (a.fixed && !b.fixed) return -1;
                    if (!a.fixed && b.fixed) return 1;
                    if (a.fixed && b.fixed) return (a.order || 0) - (b.order || 0);
                    if ((a.order || 100) !== (b.order || 100)) return (a.order || 100) - (b.order || 100);
                    return String(a.name).localeCompare(String(b.name));
                });

            var pumpData = { bn: 0, cash: 0, card: 0, sbp: 0 };
            if (res.pump && typeof res.pump === 'object') {
                pumpData = {
                    bn: Number(res.pump.bn) || 0,
                    cash: Number(res.pump.cash) || 0,
                    card: Number(res.pump.card) || 0,
                    sbp: Number(res.pump.sbp) || 0
                };
            }

            State.tetradka[branch] = {
                date: date, branch: branch,
                masters: State.mastersList.slice(),
                mastersOnShift: mastersOnShift,
                services: servicesList,
                cars: cars, records: recs,
                cash: res.cash || { start_cash: 0, expenses: [] },
                advances: res.advances || [],
                pump: pumpData
            };
        },

        getRecordsForDate: function(date, branch) {
            var records = [];
            Object.keys(State.occupiedSlots).forEach(function(key) {
                var v = State.occupiedSlots[key];
                var parts = key.split('_');
                if (parts[0] !== branch || parts[1] !== date) return;
                records.push({
                    key: key, time: parts[2],
                    car: v.carBrand || '', client: v.clientName || '',
                    phone: v.phone || '', comment: v.comment || '',
                    extraComment: v.extraComment || '', rating: v.rating || 'neutral',
                    status: 'pending', linkedCarId: null
                });
            });
            records.sort(function(a, b) { return a.time.localeCompare(b.time); });
            return records;
        },

        renderAll: function() {
            var d = Tetradka.getCurrent();
            if (!d) return;
            Tetradka.renderRecords(d);
            Tetradka.renderPump(d);
            Tetradka.renderMasters(d);
            Tetradka.renderServices(d);
            Tetradka.renderCars(d);
            Tetradka.renderTotals(d);
            Tetradka.renderSalary(d);
            Tetradka.renderAdvances(d);
            Tetradka.renderExpenses(d);
            Tetradka.renderCash(d);
        },

        renderRecords: function(d) {
            var html = '';
            var allRecords = d.records || [];
            var processed = allRecords.filter(function(r) { return r.status !== 'pending'; }).length;
            UI.$('recordsCount').textContent = processed + ' из ' + allRecords.length;

            var records = State.hideProcessedRecords
                ? allRecords.filter(function(r) { return r.status === 'pending'; })
                : allRecords;

            if (records.length === 0 && allRecords.length > 0 && State.hideProcessedRecords) {
                UI.$('recordsList').innerHTML = '<div class="cash-empty">Все записи обработаны. Нажмите «Показать обработанные», чтобы увидеть.</div>';
                return;
            }

            records.forEach(function(r) {
                var cls = r.status === 'confirmed' ? 'done' : r.status === 'declined' ? 'declined' : 'pending';
                var hasComment = r.comment || r.extraComment;
                var phone = Utils.cleanPhone(r.phone || '');
                var client = State.clientsDatabase[phone];
                var ratingNum = '', ratingCls = 'neutral';
                if (client) {
                    ratingNum = Utils.formatRating(client);
                    if (client.rating === 'good') ratingCls = 'good';
                    else if (client.rating === 'bad') ratingCls = 'bad';
                }

                html += '<div class="rec-compact ' + cls + '">';
                html += '<div class="time">' + r.time + '</div>';
                html += '<div class="info" data-open-record="' + r.key + '">';
                html += '<div class="car">' + Utils.escapeHtml(r.car) + '</div>';
                html += '<div class="client-line">';
                html += '<span class="client">' + Utils.escapeHtml(r.client || '—') + '</span>';
                if (ratingNum) html += '<span class="rec-rating ' + ratingCls + '">' + ratingNum + '</span>';
                html += '</div>';
                if (r.phone) html += '<div class="phone">' + Utils.escapeHtml(r.phone) + '</div>';
                html += '</div>';
                html += '<div class="actions">';
                if (r.status === 'pending') {
                    html += '<button class="btn success" data-confirm="' + r.key + '">✓</button>';
                    html += '<button class="btn danger" data-decline="' + r.key + '">✕</button>';
                } else if (r.status === 'confirmed') {
                    html += '<div class="status ok">✓</div>';
                } else {
                    html += '<div class="status no">✕</div>';
                }
                html += '</div>';
                if (hasComment) html += '<span class="comment-dot"></span>';
                html += '</div>';
            });
            UI.$('recordsList').innerHTML = html;

            document.querySelectorAll('[data-open-record]').forEach(function(el) {
                el.addEventListener('click', function() {
                    var key = el.dataset.openRecord;
                    if (key) Records.openModal(key);
                });
            });

            document.querySelectorAll('[data-confirm]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var key = btn.dataset.confirm;
                    var rec = d.records.find(function(x) { return x.key === key; });
                    if (!rec) return;
                    rec.status = 'confirmed';
                    var existingCar = d.cars.find(function(c) { return c.recordKey === key; });
                    if (existingCar) {
                        existingCar.recordStatus = 'confirmed';
                        rec.linkedCarId = existingCar.id;
                    } else {
                        var carId = 'car_' + Date.now();
                        d.cars.push({
                            id: carId, car: rec.car, recordKey: key, payment: '', total: 0,
                            services: [{ name: 'шиномонтаж', amount: 0, payment: '' }],
                            recordStatus: 'confirmed'
                        });
                        rec.linkedCarId = carId;
                    }
                    Api.updateRecordStatus(key, 'confirmed');
                    Tetradka.markDirty();
                    Tetradka.renderAll();
                });
            });

            document.querySelectorAll('[data-decline]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    if (!confirm('Отклонить запись? Клиент не приехал?')) return;
                    var key = btn.dataset.decline;
                    var rec = d.records.find(function(x) { return x.key === key; });
                    if (rec) rec.status = 'declined';
                    var existingCar = d.cars.find(function(c) { return c.recordKey === key; });
                    if (existingCar) existingCar.recordStatus = 'declined';
                    Api.updateRecordStatus(key, 'declined');
                    Tetradka.markDirty();
                    Tetradka.renderAll();
                });
            });
        },

        renderPump: function(d) {
            var html = '';
            var total = 0;
            ['bn', 'cash', 'card', 'sbp'].forEach(function(code) {
                var val = d.pump[code] || 0;
                total += val;
                html += '<div class="pump-row"><div class="label">' + Payments.label(code) + '</div>' +
                        '<input type="number" value="' + Utils.numToInput(val) + '" min="0" step="25" placeholder="0" data-pump="' + code + '"></div>';
            });
            html += '<div class="pump-row total"><div class="label">ИТОГО</div><div style="text-align:right;font-weight:800;color:var(--accent)" id="pumpTotalInline">' + Utils.fmtMoney(total) + '</div></div>';
            UI.$('pumpTable').innerHTML = html;
            UI.$('pumpTotal').textContent = Utils.fmtMoney(total);

            document.querySelectorAll('[data-pump]').forEach(function(inp) {
                inp.addEventListener('input', function() {
                    var val = Number(inp.value) || 0;
                    d.pump[inp.dataset.pump] = val;
                    Tetradka.markDirty();
                    Tetradka.updatePumpTotal(d);
                    Tetradka.renderTotals(d);
                    Tetradka.updateCashDisplay(d);
                });
            });
        },

        updatePumpTotal: function(d) {
            var total = Object.keys(d.pump).reduce(function(s, k) { return s + (d.pump[k] || 0); }, 0);
            var el = UI.$('pumpTotalInline');
            if (el) el.textContent = Utils.fmtMoney(total);
            UI.$('pumpTotal').textContent = Utils.fmtMoney(total);
        },

        renderMasters: function(d) {
            var html = '';
            d.masters.forEach(function(m) {
                var on = d.mastersOnShift[m.name] ? 'on' : '';
                html += '<div class="master-toggle ' + on + '" data-master="' + Utils.escapeHtml(m.name) + '"><span class="dot"></span><span>' + Utils.escapeHtml(m.name) + '</span></div>';
            });
            UI.$('mastersRow').innerHTML = html;
            var count = Object.keys(d.mastersOnShift).filter(function(k) { return d.mastersOnShift[k]; }).length;
            UI.$('mastersCount').textContent = count + ' выбрано';

            document.querySelectorAll('[data-master]').forEach(function(el) {
                el.addEventListener('click', function() {
                    var name = el.dataset.master;
                    if (d.mastersOnShift[name]) delete d.mastersOnShift[name];
                    else d.mastersOnShift[name] = true;
                    el.classList.toggle('on', !!d.mastersOnShift[name]);
                    var newCount = Object.keys(d.mastersOnShift).filter(function(k) { return d.mastersOnShift[k]; }).length;
                    UI.$('mastersCount').textContent = newCount + ' выбрано';
                    Tetradka.markDirty();
                    Tetradka.renderServices(d);
                    Tetradka.renderSalary(d);
                });
            });
        },

        renderServices: function(d) {
            var activeMasters = d.masters.filter(function(m) { return d.mastersOnShift[m.name]; });
            var headHtml = '<tr><th>Услуга</th>';
            activeMasters.forEach(function(m) { headHtml += '<th>' + Utils.escapeHtml(m.name) + '</th>'; });
            headHtml += '<th></th></tr>';
            UI.$('servicesHead').innerHTML = headHtml;

            var bodyHtml = '';
            d.services.forEach(function(svc, idx) {
                if (!svc || !svc.name) return;
                bodyHtml += '<tr><td>';
                if (svc.fixed) bodyHtml += '<span style="padding:5px 8px;display:inline-block;color:var(--text-0)">' + Utils.escapeHtml(svc.name) + ' 🔒</span>';
                else bodyHtml += '<input type="text" value="' + Utils.escapeHtml(svc.name) + '" data-svc-name="' + idx + '">';
                bodyHtml += '</td>';
                activeMasters.forEach(function(m) {
                    var val = svc.percents[m.name];
                    var cls = val !== undefined ? 'on' : '';
                    bodyHtml += '<td class="pct-cell"><input type="number" step="0.1" min="0" max="100" value="' + (val !== undefined ? val : '') + '" class="' + cls + '" data-svc-pct="' + idx + '" data-master-name="' + Utils.escapeHtml(m.name) + '" placeholder="—"></td>';
                });
                bodyHtml += '<td>';
                if (!svc.fixed) bodyHtml += '<button class="del-svc" data-del-svc="' + idx + '">✕</button>';
                bodyHtml += '</td></tr>';
            });
            UI.$('servicesBody').innerHTML = bodyHtml;

            document.querySelectorAll('[data-svc-name]').forEach(function(inp) {
                inp.addEventListener('change', function() {
                    var idx = Number(inp.dataset.svcName);
                    d.services[idx].name = inp.value.trim() || 'услуга';
                    Tetradka.markDirty();
                    Tetradka.renderAll();
                });
            });
            document.querySelectorAll('[data-svc-pct]').forEach(function(inp) {
                inp.addEventListener('input', function() {
                    var idx = Number(inp.dataset.svcPct);
                    var mn = inp.dataset.masterName;
                    var val = inp.value.trim();
                    if (val === '') { delete d.services[idx].percents[mn]; inp.classList.remove('on'); }
                    else { d.services[idx].percents[mn] = Number(val) || 0; inp.classList.add('on'); }
                    Tetradka.markDirty();
                    Tetradka.renderSalary(d);
                });
            });
            document.querySelectorAll('[data-del-svc]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    d.services.splice(Number(btn.dataset.delSvc), 1);
                    Tetradka.markDirty();
                    Tetradka.renderAll();
                });
            });
        },

        renderCars: function(d) {
            var html = '';
            var svcOptions = d.services.filter(function(s) { return s && s.name; }).map(function(s) { return s.name; });
            var paymentCodes = Payments.all();
            var total = d.cars.length;
            var hideCount = Math.min(State.carsHideCount || 0, total);
            var visibleCars = d.cars.slice(hideCount);

            UI.$('carsCount').textContent = total + ' ' + (total === 1 ? 'машина' : 'машин') +
                (hideCount > 0 ? ' (скрыто ' + hideCount + ')' : '');

            var input = UI.$('carsHideInput');
            if (input && Number(input.value) !== hideCount) input.value = hideCount;

            visibleCars.forEach(function(c, idx) {
                var originalIdx = hideCount + idx;
                var linked = c.recordKey ? 'linked' : '';
                var carTotal = c.services.reduce(function(s, x) { return s + (Number(x.amount) || 0); }, 0);
                var hasRecord = !!c.recordKey;

                html += '<div class="car-row ' + linked + '">';
                html += '<div class="car-row-head">';
                html += '<div class="num">#' + (originalIdx + 1) + (hasRecord ? ' 🔗' : '') + '</div>';
                html += '<input class="car-name" type="text" value="' + Utils.escapeHtml(c.car) + '" data-car="' + c.id + '" placeholder="МАРКА">';
                html += '<div class="total">' + Utils.fmtMoney(carTotal) + '</div>';
                if (hasRecord) html += '<button class="open-record" data-open-car-record="' + c.recordKey + '" title="Открыть запись">👁</button>';
                else html += '<div class="spacer"></div>';
                html += '<button class="del" data-car-del="' + c.id + '">✕</button>';
                html += '</div>';
                html += '<div class="car-services-row">';
                c.services.forEach(function(svc, sidx) {
                    var payCls = svc.payment ? 'has-value' : '';
                    html += '<div class="car-service-inline">';
                    html += '<select class="car-service-name" data-car-svc-name="' + c.id + '" data-car-svc-idx="' + sidx + '">';
                    svcOptions.forEach(function(name) {
                        var sel = svc.name === name ? 'selected' : '';
                        html += '<option value="' + Utils.escapeHtml(name) + '" ' + sel + '>' + Utils.escapeHtml(name) + '</option>';
                    });
                    html += '</select>';
                    html += '<input type="number" value="' + Utils.numToInput(svc.amount) + '" min="0" step="10" data-car-svc-amount="' + c.id + '" data-car-svc-idx="' + sidx + '" placeholder="0">';
                    html += '<select class="payment-select ' + payCls + '" data-car-svc-payment="' + c.id + '" data-car-svc-idx="' + sidx + '">';
                    html += '<option value="">—</option>';
                    paymentCodes.forEach(function(code) {
                        var sel = svc.payment === code ? 'selected' : '';
                        html += '<option value="' + code + '" ' + sel + '>' + Payments.label(code) + '</option>';
                    });
                    html += '</select>';
                    if (c.services.length > 1) html += '<button class="del" data-car-svc-del="' + c.id + '" data-car-svc-idx="' + sidx + '">✕</button>';
                    else html += '<div class="spacer"></div>';
                    html += '</div>';
                });
                html += '<button class="car-add-service-inline" data-car-add-svc="' + c.id + '">+ услуга</button>';
                html += '</div></div>';
            });

            UI.$('carsList').innerHTML = html || '<div class="cash-empty">Нет машин</div>';

            document.querySelectorAll('[data-car]').forEach(function(inp) {
                inp.addEventListener('change', function() {
                    var car = d.cars.find(function(c) { return c.id === inp.dataset.car; });
                    if (car) { car.car = inp.value; Tetradka.markDirty(); }
                });
            });
            document.querySelectorAll('[data-car-del]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var id = btn.dataset.carDel;
                    d.cars = d.cars.filter(function(c) { return c.id !== id; });
                    if (d.records) d.records.forEach(function(r) { if (r.linkedCarId === id) { r.linkedCarId = null; r.status = 'pending'; } });
                    Tetradka.markDirty();
                    Tetradka.renderAll();
                });
            });
            document.querySelectorAll('[data-open-car-record]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var key = btn.dataset.openCarRecord;
                    if (key) Records.openModal(key);
                });
            });
            document.querySelectorAll('[data-car-svc-name]').forEach(function(sel) {
                sel.addEventListener('change', function() {
                    var car = d.cars.find(function(c) { return c.id === sel.dataset.carSvcName; });
                    if (car) { car.services[Number(sel.dataset.carSvcIdx)].name = sel.value; Tetradka.markDirty(); Tetradka.renderSalary(d); }
                });
            });
            document.querySelectorAll('[data-car-svc-payment]').forEach(function(sel) {
                sel.addEventListener('change', function() {
                    var car = d.cars.find(function(c) { return c.id === sel.dataset.carSvcPayment; });
                    if (car) { car.services[Number(sel.dataset.carSvcIdx)].payment = sel.value; Tetradka.markDirty(); Tetradka.renderAll(); }
                });
            });
            document.querySelectorAll('[data-car-svc-amount]').forEach(function(inp) {
                inp.addEventListener('input', function() {
                    var car = d.cars.find(function(c) { return c.id === inp.dataset.carSvcAmount; });
                    if (car) {
                        car.services[Number(inp.dataset.carSvcIdx)].amount = Number(inp.value) || 0;
                        var row = inp.closest('.car-row');
                        if (row) {
                            var totalEl = row.querySelector('.car-row-head .total');
                            if (totalEl) totalEl.textContent = Utils.fmtMoney(car.services.reduce(function(s, x) { return s + (Number(x.amount) || 0); }, 0));
                        }
                        Tetradka.markDirty();
                        Tetradka.renderTotals(d);
                        Tetradka.renderSalary(d);
                        Tetradka.updateCashDisplay(d);
                    }
                });
            });
            document.querySelectorAll('[data-car-svc-del]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var car = d.cars.find(function(c) { return c.id === btn.dataset.carSvcDel; });
                    if (car && car.services.length > 1) {
                        car.services.splice(Number(btn.dataset.carSvcIdx), 1);
                        Tetradka.markDirty();
                        Tetradka.renderAll();
                    }
                });
            });
            document.querySelectorAll('[data-car-add-svc]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var car = d.cars.find(function(c) { return c.id === btn.dataset.carAddSvc; });
                    if (car) {
                        car.services.push({ name: 'подкачка', amount: 0, payment: '' });
                        Tetradka.markDirty();
                        Tetradka.renderAll();
                    }
                });
            });
        },

        renderTotals: function(d) {
            var totals = {};
            var grandTotal = 0;
            d.cars.forEach(function(c) {
                c.services.forEach(function(svc) {
                    if (!svc.payment || !svc.amount) return;
                    totals[svc.payment] = (totals[svc.payment] || 0) + Number(svc.amount);
                    grandTotal += Number(svc.amount);
                });
            });
            Object.keys(d.pump).forEach(function(code) {
                var v = d.pump[code] || 0;
                if (v > 0) { totals[code] = (totals[code] || 0) + v; grandTotal += v; }
            });

            var html = '';
            Object.keys(totals).forEach(function(code) {
                html += '<div class="total-card' + (code === 'cash' ? ' success' : '') + '"><div class="label">' + Payments.label(code) + '</div><div class="value">' + Utils.fmtMoney(totals[code]) + '</div></div>';
            });
            html += '<div class="total-card accent"><div class="label">Итого выручка</div><div class="value">' + Utils.fmtMoney(grandTotal) + '</div></div>';
            if (Object.keys(totals).length === 0) html = '<div class="total-card"><div class="label">Нет данных</div><div class="value">0 ₽</div></div>';
            UI.$('paymentsTotals').innerHTML = html;
        },

        renderSalary: function(d) {
            var activeMasters = d.masters.filter(function(m) { return d.mastersOnShift[m.name]; });
            var serviceSums = {};
            d.services.forEach(function(s) { serviceSums[s.name] = 0; });

            d.cars.forEach(function(c) {
                c.services.forEach(function(svc) {
                    var s = (svc.name || '').trim();
                    if (!s) return;
                    if (serviceSums[s] === undefined) serviceSums[s] = 0;
                    serviceSums[s] += Number(svc.amount) || 0;
                });
            });
            var pumpTotal = Object.keys(d.pump).reduce(function(sum, k) { return sum + (d.pump[k] || 0); }, 0);
            if (pumpTotal > 0) {
                if (serviceSums['подкачка'] === undefined) serviceSums['подкачка'] = 0;
                serviceSums['подкачка'] += pumpTotal;
            }

            var headHtml = '<tr><th>Услуга</th>';
            activeMasters.forEach(function(m) { headHtml += '<th>' + Utils.escapeHtml(m.name) + '</th>'; });
            headHtml += '</tr>';
            UI.$('salaryHead').innerHTML = headHtml;

            var bodyHtml = '';
            var masterTotals = {};
            activeMasters.forEach(function(m) { masterTotals[m.name] = 0; });

            d.services.forEach(function(svc) {
                if (!svc || !svc.name) return;
                var sum = serviceSums[svc.name] || 0;
                bodyHtml += '<tr><td>' + Utils.escapeHtml(svc.name) + ' <span style="color:var(--text-2);font-weight:500;font-size:11px">· ' + Utils.fmtMoney(sum) + '</span></td>';
                activeMasters.forEach(function(m) {
                    var pct = svc.percents[m.name];
                    if (pct === undefined) bodyHtml += '<td class="dim">—</td>';
                    else {
                        var salary = sum * (pct / 100);
                        masterTotals[m.name] += salary;
                        bodyHtml += '<td class="success">' + Utils.fmtMoney(Math.round(salary)) + '</td>';
                    }
                });
                bodyHtml += '</tr>';
            });
            if (activeMasters.length > 0) {
                bodyHtml += '<tr class="row-total"><td>ИТОГО</td>';
                activeMasters.forEach(function(m) { bodyHtml += '<td>' + Utils.fmtMoney(Math.round(masterTotals[m.name])) + '</td>'; });
                bodyHtml += '</tr>';
            } else {
                bodyHtml = '<tr><td colspan="2" style="text-align:center;color:var(--text-3);padding:30px">Отметьте мастеров</td></tr>';
            }
            UI.$('salaryBody').innerHTML = bodyHtml;

            var wrap = document.querySelector('.salary-wrap');
            if (!wrap) return;
            var existing = wrap.querySelector('.salary-cards-mobile');
            if (existing) existing.remove();

            var cardsWrap = document.createElement('div');
            cardsWrap.className = 'salary-cards-mobile';

            if (activeMasters.length === 0) {
                cardsWrap.innerHTML = '<div class="cash-empty">Отметьте мастеров на смене</div>';
            } else {
                activeMasters.forEach(function(m) {
                    var card = document.createElement('div');
                    card.className = 'salary-card-mobile';
                    var rows = '<div class="name"><span>' + Utils.escapeHtml(m.name) + '</span><span class="total">' + Utils.fmtMoney(Math.round(masterTotals[m.name])) + '</span></div>';
                    d.services.forEach(function(svc) {
                        if (!svc || !svc.name) return;
                        var pct = svc.percents[m.name];
                        if (pct === undefined) return;
                        var sum = serviceSums[svc.name] || 0;
                        var salary = sum * (pct / 100);
                        rows += '<div class="row"><span class="label">' + Utils.escapeHtml(svc.name) + ' · ' + pct + '%</span><span class="value">' + Utils.fmtMoney(Math.round(salary)) + '</span></div>';
                    });
                    card.innerHTML = rows;
                    cardsWrap.appendChild(card);
                });
            }
            wrap.appendChild(cardsWrap);
        },

        renderAdvances: function(d) {
            var html = '';
            var total = 0;
            d.advances.forEach(function(a) {
                total += Number(a.amount) || 0;
                html += '<div class="cash-list-item adv-item">';
                html += '<select data-adv-master="' + a.id + '">';
                d.masters.forEach(function(m) {
                    var sel = a.master === m.name ? 'selected' : '';
                    html += '<option value="' + Utils.escapeHtml(m.name) + '" ' + sel + '>' + Utils.escapeHtml(m.name) + '</option>';
                });
                html += '</select>';
                html += '<input type="number" class="amount" value="' + Utils.numToInput(a.amount) + '" min="0" step="100" data-adv-amount="' + a.id + '" placeholder="0">';
                html += '<button class="del" data-adv-del="' + a.id + '">✕</button>';
                html += '</div>';
            });
            if (d.advances.length === 0) html = '<div class="cash-empty">Нет авансов</div>';
            UI.$('advancesList').innerHTML = html;
            UI.$('advancesTotal').textContent = Utils.fmtMoney(total);

            document.querySelectorAll('[data-adv-master]').forEach(function(sel) {
                sel.addEventListener('change', function() {
                    var a = d.advances.find(function(x) { return x.id === sel.dataset.advMaster; });
                    if (a) { a.master = sel.value; Tetradka.markDirty(); }
                });
            });
            document.querySelectorAll('[data-adv-amount]').forEach(function(inp) {
                inp.addEventListener('input', function() {
                    var a = d.advances.find(function(x) { return x.id === inp.dataset.advAmount; });
                    if (a) {
                        a.amount = Number(inp.value) || 0;
                        a.payment = 'cash';
                        Tetradka.markDirty();
                        Tetradka.updateAdvancesTotal(d);
                        Tetradka.updateCashDisplay(d);
                    }
                });
            });
            document.querySelectorAll('[data-adv-del]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    d.advances = d.advances.filter(function(a) { return a.id !== btn.dataset.advDel; });
                    Tetradka.markDirty();
                    Tetradka.renderAll();
                });
            });
        },

        updateAdvancesTotal: function(d) {
            var total = d.advances.reduce(function(s, a) { return s + (Number(a.amount) || 0); }, 0);
            UI.$('advancesTotal').textContent = Utils.fmtMoney(total);
        },

        renderExpenses: function(d) {
            var html = '';
            var total = 0;
            (d.cash.expenses || []).forEach(function(e) {
                total += Number(e.amount) || 0;
                html += '<div class="cash-list-item">';
                html += '<input type="text" value="' + Utils.escapeHtml(e.description || '') + '" placeholder="на что" data-exp-desc="' + e.id + '">';
                html += '<input type="number" class="amount" value="' + Utils.numToInput(e.amount) + '" min="0" step="100" data-exp-amount="' + e.id + '" placeholder="0">';
                html += '<button class="del" data-exp-del="' + e.id + '">✕</button>';
                html += '</div>';
            });
            if (!d.cash.expenses || d.cash.expenses.length === 0) html = '<div class="cash-empty">Нет расходов</div>';
            UI.$('expensesList').innerHTML = html;
            UI.$('expensesTotal').textContent = Utils.fmtMoney(total);

            document.querySelectorAll('[data-exp-desc]').forEach(function(inp) {
                inp.addEventListener('change', function() {
                    var e = d.cash.expenses.find(function(x) { return x.id === inp.dataset.expDesc; });
                    if (e) { e.description = inp.value; Tetradka.markDirty(); }
                });
            });
            document.querySelectorAll('[data-exp-amount]').forEach(function(inp) {
                inp.addEventListener('input', function() {
                    var e = d.cash.expenses.find(function(x) { return x.id === inp.dataset.expAmount; });
                    if (e) {
                        e.amount = Number(inp.value) || 0;
                        Tetradka.markDirty();
                        Tetradka.updateExpensesTotal(d);
                        Tetradka.updateCashDisplay(d);
                    }
                });
            });
            document.querySelectorAll('[data-exp-del]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    d.cash.expenses = d.cash.expenses.filter(function(e) { return e.id !== btn.dataset.expDel; });
                    Tetradka.markDirty();
                    Tetradka.renderAll();
                });
            });
        },

        updateExpensesTotal: function(d) {
            var total = (d.cash.expenses || []).reduce(function(s, e) { return s + (Number(e.amount) || 0); }, 0);
            UI.$('expensesTotal').textContent = Utils.fmtMoney(total);
        },

        updateCashDisplay: function(d) {
            var incomeCash = d.pump.cash || 0;
            d.cars.forEach(function(c) {
                c.services.forEach(function(svc) {
                    if (svc.payment === 'cash') incomeCash += Number(svc.amount) || 0;
                });
            });
            var advancesCash = d.advances.reduce(function(sum, a) { return sum + (Number(a.amount) || 0); }, 0);
            var expensesSum = (d.cash.expenses || []).reduce(function(sum, e) { return sum + (Number(e.amount) || 0); }, 0);
            var total = Number(d.cash.start_cash) + incomeCash - advancesCash - expensesSum;

            UI.$('cashIncome').textContent = Utils.fmtMoney(incomeCash);
            UI.$('cashAdvances').textContent = Utils.fmtMoney(advancesCash);
            UI.$('cashExpenses').textContent = Utils.fmtMoney(expensesSum);
            UI.$('cashTotal').textContent = Utils.fmtMoney(total);
            if (UI.$('cashStart').value != d.cash.start_cash) UI.$('cashStart').value = d.cash.start_cash;
        },

        renderCash: function(d) { Tetradka.updateCashDisplay(d); }
    };

    // ============================================================
    // 💰 ЗАРПЛАТЫ
    // ============================================================
    var Zarp = {
        _refreshing: false,

        init: function() {
            document.querySelectorAll('.zarp-branch').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.zarp-branch').forEach(function(b) { b.classList.remove('active'); });
                    this.classList.add('active');
                    State.zarpBranch = this.dataset.branch;
                    Zarp.render();
                });
            });
            UI.$('prevMonth').addEventListener('click', function() {
                State.zarpMonth--;
                if (State.zarpMonth < 0) { State.zarpMonth = 11; State.zarpYear--; }
                Zarp.loadAndRender();
            });
            UI.$('nextMonth').addEventListener('click', function() {
                State.zarpMonth++;
                if (State.zarpMonth > 11) { State.zarpMonth = 0; State.zarpYear++; }
                Zarp.loadAndRender();
            });
            UI.$('closeMonthBtn').addEventListener('click', function() {
                if (!confirm('Закрыть месяц?\n\nОстатки перенесутся на следующий месяц для ОБОИХ филиалов.')) return;
                var btn = this;
                btn.disabled = true;
                Api.closeMonth({ year: State.zarpYear, month: State.zarpMonth }).then(function(res) {
                    btn.disabled = false;
                    if (res && !res.error) {
                        var msg = 'Месяц закрыт. Добавлено: ' + (res.rowsAdded || 0);
                        if (res.skipped > 0) msg += ', пропущено (уже было): ' + res.skipped;
                        UI.toast(msg, 'success', 3500);
                        State.salaryMonthData = null;
                        State.salaryMonthLoadedKey = null;
                        SalaryCache.clearAll();
                        Zarp.loadAndRender(true);
                    } else {
                        UI.toast((res && res.error) || 'Ошибка закрытия месяца', 'error');
                    }
                }).catch(function() {
                    btn.disabled = false;
                    UI.toast('Ошибка сети при закрытии месяца', 'error');
                });
            });
            UI.$('addMarkBtn').addEventListener('click', Zarp.openMarkModal);
            UI.$('refreshZarpBtn').addEventListener('click', function() {
                Zarp.fullRefresh(this);
            });
        },

        fullRefresh: function(btn) {
            if (Zarp._refreshing) return;
            Zarp._refreshing = true;
            var originalText = btn.textContent;
            btn.textContent = '⏳';
            btn.disabled = true;

            var currentKey = State.zarpYear + '_' + State.zarpMonth;
            State.salaryMonthData = null;
            State.salaryMonthLoadedKey = null;
            SalaryCache.clear(currentKey);

            UI.$('monthSummary').innerHTML = '<div class="skeleton" style="height:80px"></div>';
            UI.$('daysBody').innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px"><span class="spinner"></span></td></tr>';
            UI.$('combinedBody').innerHTML = '';
            UI.$('marksList').innerHTML = '<div class="skeleton" style="height:60px"></div>';

            Api.getSalaryMonth(State.zarpYear, State.zarpMonth).then(function(res) {
                State.salaryMonthData = res || { days: [], advances: [], marks: [], masters: [] };
                State.salaryMonthLoadedKey = currentKey;
                SalaryCache.save(currentKey, State.salaryMonthData);
                Zarp.render();
                UI.toast('Данные обновлены', 'success', 1500);
                Zarp._refreshing = false;
                btn.textContent = originalText;
                btn.disabled = false;
            }).catch(function() {
                Zarp._refreshing = false;
                btn.textContent = originalText;
                btn.disabled = false;
                UI.toast('Ошибка обновления', 'error');
            });
        },

        loadAndRender: function(force) {
            UI.$('monthLabel').textContent = Zarp.monthLabel(State.zarpYear, State.zarpMonth);
            var currentKey = State.zarpYear + '_' + State.zarpMonth;
            if (!force && State.salaryMonthData && State.salaryMonthLoadedKey === currentKey) {
                Zarp.render();
                return;
            }
            if (!force) {
                var cached = SalaryCache.load(currentKey);
                if (cached) {
                    State.salaryMonthData = cached;
                    State.salaryMonthLoadedKey = currentKey;
                    Zarp.render();
                    Zarp._backgroundRefresh(currentKey);
                    return;
                }
            }
            UI.$('monthSummary').innerHTML = '<div class="skeleton" style="height:80px"></div>';
            UI.$('daysBody').innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px"><span class="spinner"></span></td></tr>';
            UI.$('combinedBody').innerHTML = '';
            UI.$('marksList').innerHTML = '<div class="skeleton" style="height:60px"></div>';

            Api.getSalaryMonth(State.zarpYear, State.zarpMonth).then(function(res) {
                State.salaryMonthData = res || { days: [], advances: [], marks: [], masters: [] };
                State.salaryMonthLoadedKey = currentKey;
                SalaryCache.save(currentKey, State.salaryMonthData);
                Zarp.render();
            });
        },

        _backgroundRefresh: function(key) {
            Api.getSalaryMonth(State.zarpYear, State.zarpMonth).then(function(res) {
                if (res && !res.error) {
                    if (State.salaryMonthLoadedKey === key) {
                        State.salaryMonthData = res;
                        SalaryCache.save(key, res);
                        Zarp.render();
                    } else {
                        SalaryCache.save(key, res);
                    }
                }
            });
        },

        render: function() {
            var data = State.salaryMonthData || { days: [], advances: [], marks: [], masters: [] };
            Zarp.renderMonthSummary(data);
            Zarp.renderDaysTable(data);
            Zarp.renderCombined(data);
            Zarp.renderMarks(data);
        },

        renderMonthSummary: function(data) {
            var branch = State.zarpBranch;
            var days = (data.days || []).filter(function(d) { return d.branch === branch; });
            var totals = { cash: 0, sbp: 0, bn: 0, card: 0, almir: 0, inv: 0, vyruch: 0, salary: 0 };
            days.forEach(function(d) {
                totals.cash += d.cash || 0;
                totals.sbp += d.sbp || 0;
                totals.bn += d.bn || 0;
                totals.card += d.card || 0;
                totals.almir += d.almir || 0;
                totals.inv += d.inv || 0;
                totals.vyruch += d.vyruch || 0;
                Object.keys(d.payroll || {}).forEach(function(m) { totals.salary += d.payroll[m] || 0; });
            });

            var html = '';
            html += Zarp.card('Касса (нал)', totals.cash, 'success');
            html += Zarp.card('СПБ', totals.sbp, 'accent');
            html += Zarp.card('Б/Н', totals.bn, '');
            html += Zarp.card('Карта', totals.card, '');
            html += Zarp.card('Альмир', totals.almir, '');
            html += Zarp.card('По счёту', totals.inv, '');
            html += Zarp.card('ИТОГО выручка', totals.vyruch, 'accent');
            html += Zarp.card('Зарплаты мастеров', totals.salary, 'danger');
            UI.$('monthSummary').innerHTML = html;
            UI.$('daysCount').textContent = days.length + ' дней';
        },

        card: function(label, value, cls) {
            return '<div class="summary-card ' + (cls || '') + '"><div class="label">' + label + '</div><div class="value">' + Utils.fmtMoney(value) + '</div></div>';
        },

        renderDaysTable: function(data) {
            var branch = State.zarpBranch;
            var days = (data.days || []).filter(function(d) { return d.branch === branch; });
            days.sort(function(a, b) { return a.date.localeCompare(b.date); });

            var mastersOfBranch = {};
            days.forEach(function(d) { Object.keys(d.payroll || {}).forEach(function(m) { mastersOfBranch[m] = true; }); });
            var masterNames = Object.keys(mastersOfBranch);

            var headHtml = '<tr><th style="width:46px;min-width:46px;max-width:46px;text-align:center">Дата</th><th>Касса</th><th>СПБ</th><th>Б/Н</th><th>Карта</th><th>Нал</th><th>Альмир</th><th>Счёт</th><th>Выручка</th>';
            headHtml += '<th style="text-align:center;background:rgba(77,158,255,0.1);color:var(--accent)" colspan="' + masterNames.length + '">Зарплаты мастеров</th></tr>';
            var headHtml2 = '<tr><th style="width:46px;min-width:46px;max-width:46px"></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th><th></th>';
            masterNames.forEach(function(m) { headHtml2 += '<th>' + Utils.escapeHtml(m) + '</th>'; });
            headHtml2 += '</tr>';
            UI.$('daysHead').innerHTML = headHtml + headHtml2;

            if (days.length === 0) {
                UI.$('daysBody').innerHTML = '<tr><td colspan="' + (9 + masterNames.length) + '" style="text-align:center;color:var(--text-3);padding:30px">Нет данных</td></tr>';
                return;
            }

            var bodyHtml = '';
            days.forEach(function(d) {
                var dd = d.date.split('-')[2];
                bodyHtml += '<tr><td>' + dd + '.' + String(State.zarpMonth + 1).padStart(2, '0') + '</td>';
                bodyHtml += '<td>' + Zarp.num(d.cassa) + '</td>';
                bodyHtml += '<td class="accent">' + Zarp.num(d.sbp) + '</td>';
                bodyHtml += '<td>' + Zarp.num(d.bn) + '</td>';
                bodyHtml += '<td>' + Zarp.num(d.card) + '</td>';
                bodyHtml += '<td class="success">' + Zarp.num(d.cash) + '</td>';
                bodyHtml += '<td>' + Zarp.num(d.almir) + '</td>';
                bodyHtml += '<td>' + Zarp.num(d.inv) + '</td>';
                bodyHtml += '<td class="accent">' + Zarp.num(d.vyruch) + '</td>';
                masterNames.forEach(function(m) {
                    var v = (d.payroll || {})[m] || 0;
                    bodyHtml += '<td' + (v > 0 ? ' class="success"' : ' class="dim"') + '>' + Zarp.num(v) + '</td>';
                });
                bodyHtml += '</tr>';
            });

            var totals = { cassa: 0, sbp: 0, bn: 0, card: 0, cash: 0, almir: 0, inv: 0, vyruch: 0 };
            days.forEach(function(d) {
                totals.cassa += d.cassa || 0;
                totals.sbp += d.sbp || 0;
                totals.bn += d.bn || 0;
                totals.card += d.card || 0;
                totals.cash += d.cash || 0;
                totals.almir += d.almir || 0;
                totals.inv += d.inv || 0;
                totals.vyruch += d.vyruch || 0;
            });
            bodyHtml += '<tr class="row-total"><td>ИТОГО</td>';
            bodyHtml += '<td>' + Zarp.num(totals.cassa) + '</td><td>' + Zarp.num(totals.sbp) + '</td>';
            bodyHtml += '<td>' + Zarp.num(totals.bn) + '</td><td>' + Zarp.num(totals.card) + '</td>';
            bodyHtml += '<td>' + Zarp.num(totals.cash) + '</td><td>' + Zarp.num(totals.almir) + '</td>';
            bodyHtml += '<td>' + Zarp.num(totals.inv) + '</td><td>' + Zarp.num(totals.vyruch) + '</td>';
            masterNames.forEach(function(m) {
                var s = 0;
                days.forEach(function(d) { s += (d.payroll || {})[m] || 0; });
                bodyHtml += '<td>' + Zarp.num(s) + '</td>';
            });
            bodyHtml += '</tr>';

            UI.$('daysBody').innerHTML = bodyHtml;
        },

        renderCombined: function(data) {
            var allMasters = {};
            (data.days || []).forEach(function(d) { Object.keys(d.payroll || {}).forEach(function(m) { allMasters[m] = true; }); });
            (data.advances || []).forEach(function(a) { allMasters[a.master] = true; });
            (data.marks || []).forEach(function(m) { allMasters[m.master] = true; });

            var html = '';
            var totalSalary = 0, totalAdv = 0, totalBal = 0;

            Object.keys(allMasters).forEach(function(master) {
                var salary = 0;
                (data.days || []).forEach(function(d) { salary += (d.payroll || {})[master] || 0; });
                var advancesCassa = 0;
                (data.advances || []).forEach(function(a) { if (a.master === master) advancesCassa += a.amount; });
                var advancesExt = 0;
                (data.marks || []).forEach(function(m) { if (m.master === master && m.type === 'adv') advancesExt += m.amount; });
                var advances = advancesCassa + advancesExt;
                var warn = 0, bad = 0, good = 0;
                (data.marks || []).forEach(function(m) {
                    if (m.master !== master) return;
                    if (m.type === 'warn') warn += m.amount;
                    else if (m.type === 'bad') bad += m.amount;
                    else if (m.type === 'good') good += m.amount;
                });
                var balance = salary + warn + good - advances - bad;
                if (salary === 0 && advances === 0 && warn === 0 && bad === 0 && good === 0) return;

                totalSalary += salary;
                totalAdv += advances;
                totalBal += balance;

                var marksHtml = '';
                var hasMarks = false;
                if (warn > 0) { marksHtml += '<span class="tag warn">🟡 +' + warn.toLocaleString('ru-RU') + '</span>'; hasMarks = true; }
                if (bad > 0) { marksHtml += '<span class="tag bad">🔴 −' + bad.toLocaleString('ru-RU') + '</span>'; hasMarks = true; }
                if (good > 0) { marksHtml += '<span class="tag good">🟢 +' + good.toLocaleString('ru-RU') + '</span>'; hasMarks = true; }
                if (!hasMarks) marksHtml = '<span style="color:var(--text-3);font-size:11px">—</span>';

                html += '<tr><td>' + Utils.escapeHtml(master) + '</td>';
                html += '<td class="success">' + Utils.fmtMoney(salary) + '</td>';
                html += '<td class="warning">' + Utils.fmtMoney(advances) + '</td>';
                html += '<td class="' + (balance >= 0 ? 'accent' : 'danger') + '">' + Utils.fmtMoney(balance) + '</td>';
                html += '<td>' + marksHtml + '</td></tr>';
            });

            html += '<tr class="row-total"><td>ИТОГО</td>';
            html += '<td>' + Utils.fmtMoney(totalSalary) + '</td>';
            html += '<td>' + Utils.fmtMoney(totalAdv) + '</td>';
            html += '<td>' + Utils.fmtMoney(totalBal) + '</td><td></td></tr>';

            UI.$('combinedBody').innerHTML = html;
        },

        renderMarks: function(data) {
            var allItems = [];
            (data.advances || []).forEach(function(a) {
                allItems.push({
                    id: 'cassa_' + a.id, type: 'adv-cassa',
                    master: a.master, amount: a.amount,
                    comment: a.comment || '', date: a.date,
                    branch: a.branch || '', readonly: true
                });
            });
            (data.marks || []).forEach(function(m) {
                allItems.push({
                    id: m.id, type: m.type, master: m.master, amount: m.amount,
                    comment: m.comment || '', date: m.date, branch: m.branch || '', readonly: false
                });
            });
            allItems.sort(function(a, b) { return a.date < b.date ? 1 : -1; });

            var html = '';
            if (allItems.length === 0) html = '<div class="cash-empty">Нет пометок за месяц</div>';
            else {
                allItems.forEach(function(item) {
                    var typeLabel = item.type === 'adv-cassa' ? '💵 Аванс'
                                  : item.type === 'adv' ? '💰 Аванс'
                                  : item.type === 'warn' ? '🟡 Остаток'
                                  : item.type === 'bad' ? '🔴 Долг'
                                  : '🟢 Премия';
                    var branchIco = item.branch === 'ryabinina' ? '🏠' : (item.branch === 'amundsena' ? '🏭' : '•');
                    html += '<div class="mark-item ' + item.type + '">';
                    html += '<div class="date">' + item.date.slice(8) + '.' + item.date.slice(5, 7) + '</div>';
                    html += '<div class="branch-ico" title="' + (item.branch === 'ryabinina' ? 'Рябинина' : item.branch === 'amundsena' ? 'Амундсена' : '—') + '">' + branchIco + '</div>';
                    html += '<div class="master-block">';
                    html += '<span class="master">' + Utils.escapeHtml(item.master) + '</span>';
                    if (item.comment) html += '<span class="comment">· ' + Utils.escapeHtml(item.comment) + '</span>';
                    html += '</div>';
                    html += '<div class="amount">' + Utils.fmtMoney(item.amount) + '</div>';
                    html += '<div class="type">' + typeLabel + '</div>';
                    if (item.readonly) html += '<button class="del disabled" disabled title="Из кассы">🔒</button>';
                    else html += '<button class="del" data-mark-del="' + item.id + '">✕</button>';
                    html += '</div>';
                });
            }
            UI.$('marksList').innerHTML = html;

            document.querySelectorAll('[data-mark-del]').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    Api.deleteMark(btn.dataset.markDel).then(function() {
                        UI.toast('Пометка удалена', 'success');
                        State.salaryMonthData = null;
                        State.salaryMonthLoadedKey = null;
                        SalaryCache.clear(State.zarpYear + '_' + State.zarpMonth);
                        Zarp.loadAndRender(true);
                    });
                });
            });
        },

        openMarkModal: function() {
            var content = UI.$('markModalContent');
            content.className = 'modal-content';
            content.innerHTML =
                '<div class="modal-header">' +
                    '<div><h2 style="font-size:18px;font-weight:700">Добавить пометку</h2></div>' +
                    '<button class="close-modal-btn" data-close-modal="mark">×</button>' +
                '</div>' +
                '<div class="form-group"><label>Мастер</label><select class="form-control" id="markMaster"></select></div>' +
                '<div class="form-group"><label>Тип</label><select class="form-control" id="markType">' +
                    '<option value="adv">💰 Аванс (вне кассы)</option>' +
                    '<option value="warn">🟡 Остаток с прошлого месяца</option>' +
                    '<option value="bad">🔴 Долг</option>' +
                    '<option value="good">🟢 Премия</option>' +
                '</select></div>' +
                '<div class="form-group"><label>Сумма (₽)</label><input type="number" class="form-control" id="markAmount" placeholder="0" step="100" min="0"></div>' +
                '<div class="form-group"><label>Комментарий</label><input type="text" class="form-control" id="markComment" placeholder="необязательно"></div>' +
                '<div class="record-actions"><button class="btn" data-close-modal="mark">Отмена</button><button class="btn primary" id="saveMarkBtn">Сохранить</button></div>';

            var sel = UI.$('markMaster');
            var optionsHtml = '<option value="">— выберите —</option>';
            State.mastersList.forEach(function(m) { optionsHtml += '<option value="' + Utils.escapeHtml(m.name) + '">' + Utils.escapeHtml(m.name) + '</option>'; });
            sel.innerHTML = optionsHtml;

            UI.$('markModal').classList.add('show');

            UI.$('saveMarkBtn').addEventListener('click', function() {
                var master = UI.$('markMaster').value;
                var type = UI.$('markType').value;
                var amount = Number(UI.$('markAmount').value) || 0;
                var comment = UI.$('markComment').value.trim();
                if (!master) { UI.toast('Выберите мастера', 'error'); return; }
                if (amount <= 0) { UI.toast('Введите сумму', 'error'); return; }

                var date = State.zarpYear + '-' + String(State.zarpMonth + 1).padStart(2, '0') + '-01';
                Api.addMark({
                    id: 'mark_' + Date.now(),
                    date: date, branch: State.zarpBranch,
                    master: master, type: type,
                    amount: amount, comment: comment
                }).then(function(res) {
                    if (res && !res.error) {
                        UI.toast('Пометка добавлена', 'success');
                        Zarp.closeModal();
                        State.salaryMonthData = null;
                        State.salaryMonthLoadedKey = null;
                        SalaryCache.clear(State.zarpYear + '_' + State.zarpMonth);
                        Zarp.loadAndRender(true);
                    } else UI.toast('Ошибка', 'error');
                });
            });
        },

        closeModal: function() { UI.$('markModal').classList.remove('show'); },
        num: function(v) { v = Number(v) || 0; if (v === 0) return '—'; return v.toLocaleString('ru-RU'); },
        monthLabel: function(year, month) {
            var M = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
            return M[month] + ' ' + year;
        }
    };

    // ============================================================
    // 🎯 APP
    // ============================================================
    var App = {
        addClientFromRecord: function(slotKey, rec) {
            if (!rec || !rec.phone) return;
            var phone = Utils.cleanPhone(rec.phone);
            var parts = slotKey.split('_');
            var branch = parts[0], date = parts[1], time = parts[2], car = parts[3];

            if (!State.clientsDatabase[phone]) {
                State.clientsDatabase[phone] = {
                    phone: rec.phone, name: rec.clientName || '',
                    cars: {}, rating: rec.rating || 'neutral',
                    visits: 0, goodCount: 0, badCount: 0, neutralCount: 0, history: []
                };
            }
            var c = State.clientsDatabase[phone];
            c.visits++;
            var rating = rec.rating || 'neutral';
            if (rating === 'good') c.goodCount++;
            else if (rating === 'bad') c.badCount++;
            else c.neutralCount++;
            if (rating !== 'neutral') c.rating = rating;
            var brand = rec.carBrand || '—';
            if (!c.cars[brand]) c.cars[brand] = 0;
            c.cars[brand]++;
            if (rec.clientName) c.name = rec.clientName;
            c.history.push({
                branch: branch, date: date, time: time, car: car, key: slotKey,
                services: Utils.parseServices(rec.services),
                size: rec.size || '', rating: rating,
                comment: rec.comment || '', extraComment: rec.extraComment || ''
            });
            c.history.sort(function(a, b) {
                return (String(b.date || '') + String(b.time || '')).localeCompare(String(a.date || '') + String(a.time || ''));
            });
            State.clientsVersion++;
        },

        removeClientByKey: function(slotKey) {
            var rec = State.occupiedSlots[slotKey];
            if (!rec) return;
            var phone = Utils.cleanPhone(rec.phone);
            var c = State.clientsDatabase[phone];
            if (!c) return;
            c.visits--;
            var rating = rec.rating || 'neutral';
            if (rating === 'good') c.goodCount--;
            else if (rating === 'bad') c.badCount--;
            else c.neutralCount--;
            var brand = rec.carBrand || '—';
            if (c.cars[brand]) {
                c.cars[brand]--;
                if (c.cars[brand] <= 0) delete c.cars[brand];
            }
            c.history = c.history.filter(function(h) { return h.key !== slotKey; });
            if (c.visits <= 0) delete State.clientsDatabase[phone];
            State.clientsVersion++;
            State.journalVersion++;
        },

        saveToCache: function() {
            LocalCache.save({
                records: State.occupiedSlots,
                prices: State.prices,
                masters: State.mastersList
            });
        },

        applyBootstrap: function(data) {
            if (!data) return;

            // 🔑 Запоминаем версию данных
            if (data.dataVersion !== undefined) {
                State.lastDataVersion = String(data.dataVersion);
            }

            if (data.records && !data.records.error) {
                var normalized = Utils.normalizeAllKeys(data.records);

                var now = Date.now();
                var optimisticToKeep = {};
                Object.keys(State.occupiedSlots).forEach(function(key) {
                    var local = State.occupiedSlots[key];
                    if (!local || !local._optimistic) return;
                    if ((now - (local._optimisticAt || 0)) > Config.OPTIMISTIC_TTL) return;
                    if (normalized[key]) return;
                    optimisticToKeep[key] = local;
                });

                State.occupiedSlots = normalized;
                Object.keys(optimisticToKeep).forEach(function(key) {
                    State.occupiedSlots[key] = optimisticToKeep[key];
                });

                App.rebuildClients();
            }

            if (data.prices && !data.prices.error) {
                State.prices = {
                    ryabinina: data.prices.ryabinina || null,
                    amundsena: data.prices.amundsena || null
                };
                State.pricesLoaded = true;
            }

            if (Array.isArray(data.masters)) {
                State.mastersList = data.masters;
            }
        },

        bootstrap: function() {
            var date = State.tetradkaDate || new Date().toISOString().slice(0, 10);
            State.tetradkaDate = date;

            var cached = LocalCache.load();
            if (cached && cached.data) {
                App.applyBootstrap({
                    records: cached.data.records,
                    prices: cached.data.prices,
                    masters: cached.data.masters
                });
                App.renderAll();
            } else {
                UI.$('slotsContainer').innerHTML = UI.skeletonSlots(6);
            }

            return Api.getBootstrap().then(function(data) {
                if (data && !data.error) {
                    App.applyBootstrap(data);
                    App.renderAll();
                    App.saveToCache();
                    NewRecord.renderServicesGrid();
                } else if (!cached) {
                    return App.fallbackLoad();
                }
            }).catch(function(e) {
                console.error('Bootstrap:', e);
                if (!cached) return App.fallbackLoad();
            });
        },

        fallbackLoad: function() {
            return Api.getAll().then(function(serverData) {
                if (serverData && !serverData.error) {
                    State.occupiedSlots = Utils.normalizeAllKeys(serverData);
                    App.rebuildClients();
                }
                return Api.getMasters();
            }).then(function(masters) {
                if (Array.isArray(masters)) State.mastersList = masters;
                App.renderAll();
                NewRecord.renderServicesGrid();
            });
        },

        renderAll: function() {
            NewRecord.renderSlots();
            Journal.invalidate();
            Clients.invalidate();
            Journal.render();
            Clients.render();
            App.updateStats();
            if (UI.$('page-tetradka').classList.contains('active')) Tetradka.renderAll();
            if (UI.$('page-zarplaty').classList.contains('active')) Zarp.render();
        },

        rebuildClients: function() {
            State.clientsDatabase = {};
            Object.keys(State.occupiedSlots).forEach(function(key) {
                var rec = State.occupiedSlots[key];
                if (!rec || !rec.phone) return;
                var phone = Utils.cleanPhone(rec.phone);
                var parts = key.split('_');
                var branch = parts[0], date = parts[1], time = parts[2], car = parts[3];

                if (!State.clientsDatabase[phone]) {
                    State.clientsDatabase[phone] = {
                        phone: rec.phone, name: rec.clientName || '',
                        cars: {}, rating: rec.rating || 'neutral',
                        visits: 0, goodCount: 0, badCount: 0, neutralCount: 0, history: []
                    };
                }
                var c = State.clientsDatabase[phone];
                c.visits++;
                var rating = rec.rating || 'neutral';
                if (rating === 'good') c.goodCount++;
                else if (rating === 'bad') c.badCount++;
                else c.neutralCount++;
                if (rating !== 'neutral') c.rating = rating;
                var brand = rec.carBrand || '—';
                if (!c.cars[brand]) c.cars[brand] = 0;
                c.cars[brand]++;
                if (rec.clientName) c.name = rec.clientName;
                c.history.push({
                    branch: branch, date: date, time: time, car: car, key: key,
                    services: Utils.parseServices(rec.services),
                    size: rec.size || '', rating: rating,
                    comment: rec.comment || '', extraComment: rec.extraComment || ''
                });
            });
            Object.keys(State.clientsDatabase).forEach(function(k) {
                var c = State.clientsDatabase[k];
                c.history.sort(function(a, b) {
                    return (String(b.date || '') + String(b.time || '')).localeCompare(String(a.date || '') + String(a.time || ''));
                });
            });
            State.clientsVersion++;
            State.journalVersion++;
        },

        updateStats: function() {
            var date = UI.$('datePicker').value;
            if (date) {
                var slots = Utils.getTimeSlots(date);
                var booked = 0;
                var total = 0;
                slots.forEach(function(t) {
                    Config.CARS.forEach(function(c) {
                        total++;
                        if (State.occupiedSlots[State.currentBranch + '_' + date + '_' + t + '_' + c]) booked++;
                    });
                });
                UI.$('statFreeSlots').textContent = total - booked;
                UI.$('statBooked').textContent = booked;
            }
        },

        checkClientByPhone: function() {
            var phone = Utils.cleanPhone(UI.$('phone').value);
            var hint = UI.$('autocompleteHint');
            if (phone.length < 11) {
                hint.classList.remove('show');
                App.hideCarsChips();
                return;
            }
            var client = State.clientsDatabase[phone];
            if (client && client.name) {
                var carsList = Object.keys(client.cars).map(function(b) {
                    return b + (client.cars[b] > 1 ? ' (' + client.cars[b] + ')' : '');
                }).join(', ');
                var stars = Utils.formatRating(client);
                var cls = client.rating === 'good' ? 'good' : client.rating === 'bad' ? 'bad' : 'neutral';
                hint.innerHTML =
                    '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px">' +
                        '<span>Клиент: <span class="name">' + Utils.escapeHtml(client.name) + '</span></span>' +
                        '<span class="rating-big ' + cls + '">' + stars + '</span>' +
                    '</div>' +
                    '<div style="margin-top:6px;font-size:11px;color:var(--text-2)">🚗 ' + Utils.escapeHtml(carsList) + ' · 📊 ' + client.visits + ' визитов</div>' +
                    '<div class="actions">' +
                        '<button type="button" onclick="App.fillClient()">✓ Заполнить</button>' +
                        '<button type="button" onclick="App.dismissAutocomplete()">✕ Пропустить</button>' +
                    '</div>';
                hint.classList.add('show');
            } else {
                hint.classList.remove('show');
                App.hideCarsChips();
            }
        },

        fillClient: function() {
            var phone = Utils.cleanPhone(UI.$('phone').value);
            var client = State.clientsDatabase[phone];
            if (!client) return;
            UI.$('clientName').value = client.name || '';
            if (client.rating === 'good' || client.rating === 'bad') App.setRating(client.rating);
            var cars = Object.keys(client.cars);
            if (cars.length === 1 && cars[0] !== '—') { UI.$('carBrand').value = cars[0]; App.hideCarsChips(); }
            else if (cars.length > 1) { UI.$('carBrand').value = ''; App.showCarsChips(client); }
            else { UI.$('carBrand').value = ''; App.hideCarsChips(); }
            UI.$('autocompleteHint').classList.remove('show');
            UI.toast('Данные заполнены', 'success');
            NewRecord.updateSubmitState();
        },

        dismissAutocomplete: function() { UI.$('autocompleteHint').classList.remove('show'); },
        hideCarsChips: function() {
            var el = UI.$('carsChips');
            el.style.display = 'none';
            el.innerHTML = '';
        },
        showCarsChips: function(client) {
            var el = UI.$('carsChips');
            var cars = Object.keys(client.cars).map(function(k) { return [k, client.cars[k]]; });
            if (cars.length <= 1) { App.hideCarsChips(); return; }
            el.style.display = 'flex';
            el.innerHTML = '<div class="label">Машины клиента:</div>';
            cars.forEach(function(entry) {
                var brand = entry[0], count = entry[1];
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'car-chip';
                chip.innerHTML = Utils.escapeHtml(brand) + ' <span>' + count + '</span>';
                chip.addEventListener('click', function() {
                    el.querySelectorAll('.car-chip').forEach(function(c) { c.classList.remove('active'); });
                    chip.classList.add('active');
                    UI.$('carBrand').value = brand === '—' ? '' : brand;
                    NewRecord.updateSubmitState();
                });
                el.appendChild(chip);
            });
        },

        setRating: function(rating) {
            State.clientRating = (rating === 'good' || rating === 'bad') ? rating : null;
            UI.$('ratingGood').classList.toggle('active', State.clientRating === 'good');
            UI.$('ratingBad').classList.toggle('active', State.clientRating === 'bad');
        },

        toggleSidebar: function(open) {
            var sidebar = UI.$('sidebar');
            var backdrop = UI.$('sidebarBackdrop');
            if (!sidebar || !backdrop) return;
            if (open === undefined) open = !sidebar.classList.contains('open');
            sidebar.classList.toggle('open', open);
            backdrop.classList.toggle('show', open);
            document.body.style.overflow = open ? 'hidden' : '';
        },

        bindEvents: function() {
            UI.$('burgerBtn').addEventListener('click', function() { App.toggleSidebar(true); });
            UI.$('sidebarBackdrop').addEventListener('click', function() { App.toggleSidebar(false); });

            UI.$('mobileRefreshBtn').addEventListener('click', function() {
                LocalCache.clear();
                SalaryCache.clearAll();
                State.salaryMonthData = null;
                State.salaryMonthLoadedKey = null;
                State.pricesLoaded = false;
                State.tetradkaLoaded = { ryabinina: false, amundsena: false };
                State.tetradkaLoadFailed = false;
                State.lastDataVersion = null;  // 🔑 сброс версии
                State.clientsDatabase = {};
                Clients.invalidate();
                Journal.invalidate();
                App.bootstrap();
                UI.toast('Обновлено', 'success', 1500);
            });

            var refreshNR = UI.$('refreshNewRecordBtn');
            if (refreshNR) {
                refreshNR.addEventListener('click', function() {
                    App.refreshNewRecord(this);
                });
            }

            document.querySelectorAll('.nav-item[data-page]').forEach(function(item) {
                item.addEventListener('click', function() {
                    var page = this.dataset.page;
                    document.querySelectorAll('.nav-item[data-page]').forEach(function(i) { i.classList.remove('active'); });
                    this.classList.add('active');
                    document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
                    UI.$('page-' + page).classList.add('active');

                    var title = this.textContent.trim().replace(/^\S+\s/, '').replace(/\d+$/, '').trim();
                    UI.$('mobileTitle').textContent = title;

                    if (page === 'journal') Journal.render();
                    if (page === 'clients') Clients.render();
                    if (page === 'price') Prices.render();
                    if (page === 'tetradka') Tetradka.loadDay();
                    if (page === 'zarplaty') Zarp.loadAndRender();

                    if (window.innerWidth <= 900) App.toggleSidebar(false);
                });

                var preloadPage = function() {
                    var page = item.dataset.page;
                    if (page === 'tetradka' && !State.tetradkaLoaded[State.tetradkaBranch]) {
                        Tetradka.loadDay();
                    }
                    if (page === 'zarplaty' && (!State.salaryMonthData || State.salaryMonthLoadedKey !== (State.zarpYear + '_' + State.zarpMonth))) {
                        Zarp.loadAndRender();
                    }
                };
                item.addEventListener('mouseenter', preloadPage, { once: true });
                item.addEventListener('touchstart', preloadPage, { once: true, passive: true });
            });

            document.querySelectorAll('.price-branch').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    document.querySelectorAll('.price-branch').forEach(function(b) { b.classList.remove('active'); });
                    this.classList.add('active');
                    State.priceBranch = this.dataset.branch;
                    Prices.render();
                });
            });

            UI.$('reloadPricesBtn').addEventListener('click', function() {
                UI.setLoading('reloadPricesBtn', true, null, '↻ Обновление...');
                State.pricesLoaded = false;
                Prices.loadFromServer(true).then(function() {
                    UI.setLoading('reloadPricesBtn', false);
                    UI.toast('Прайс обновлён', 'success');
                });
            });

            UI.$('clientSearch').addEventListener('input', Utils.debounce(function() {
                Clients.invalidate();
                Clients.render();
            }, 200));
            UI.$('journalSearch').addEventListener('input', Utils.debounce(function() {
                Journal.invalidate();
                Journal.render();
            }, 200));

            document.addEventListener('click', function(e) {
                var closeBtn = e.target.closest('[data-close-modal]');
                if (closeBtn) {
                    var which = closeBtn.dataset.closeModal;
                    if (which === 'record') Records.closeModal();
                    else if (which === 'move') Move.close();
                    else if (which === 'client') Clients.closeModal();
                    else if (which === 'mark') Zarp.closeModal();
                }
            });

            UI.$('clientModal').addEventListener('click', function(e) {
                if (e.target === UI.$('clientModal')) Clients.closeModal();
            });
            UI.$('recordModal').addEventListener('click', function(e) {
                if (e.target === UI.$('recordModal')) Records.closeModal();
            });
            UI.$('moveModal').addEventListener('click', function(e) {
                if (e.target === UI.$('moveModal')) Move.close();
            });
            UI.$('markModal').addEventListener('click', function(e) {
                if (e.target === UI.$('markModal')) Zarp.closeModal();
            });

            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    Clients.closeModal();
                    Records.closeModal();
                    Move.close();
                    Zarp.closeModal();
                    if (window.innerWidth <= 900) App.toggleSidebar(false);
                }
            });

            window.addEventListener('resize', function() {
                if (window.innerWidth > 900) App.toggleSidebar(false);
            });

            document.addEventListener('visibilitychange', function() {
                if (!document.hidden && !State.isUpdating) {
                    if (Date.now() - State.lastBootstrapAt > 180000) App.bootstrap();
                }
            });

            window.addEventListener('online', function() {
                UI.toast('Соединение восстановлено', 'success');
                App.bootstrap();
            });
            window.addEventListener('offline', function() {
                UI.toast('Нет соединения — работаем из кэша', 'warning');
            });

            window.Records = Records;
            window.Clients = Clients;
            window.App = App;
            window.Prices = Prices;
            window.Move = Move;
            window.Zarp = Zarp;
            window.Tetradka = Tetradka;
        },

        refreshNewRecord: function(btn) {
            var originalText = btn.textContent;
            btn.textContent = '⏳';
            btn.disabled = true;

            LocalCache.clear();
            State.salaryMonthData = null;
            State.salaryMonthLoadedKey = null;
            State.pricesLoaded = false;
            State.lastDataVersion = null;  // 🔑 сброс версии

            Api.getBootstrap().then(function(data) {
                if (data && !data.error) {
                    App.applyBootstrap(data);
                    NewRecord.renderSlots();
                    Journal.invalidate();
                    Clients.invalidate();
                    Journal.render();
                    Clients.render();
                    App.updateStats();
                    App.saveToCache();
                    UI.toast('Данные обновлены', 'success', 1500);
                } else {
                    UI.toast('Не удалось обновить', 'error');
                }
                btn.textContent = originalText;
                btn.disabled = false;
            }).catch(function() {
                btn.textContent = originalText;
                btn.disabled = false;
                UI.toast('Ошибка обновления', 'error');
            });
        },

        init: function() {
            App.bindEvents();
            NewRecord.init();
            Tetradka.init();
            Zarp.init();
            flatpickr.localize(flatpickr.l10ns.ru);
            State.tetradkaDate = new Date().toISOString().slice(0, 10);

            setTimeout(function() { Api.ping(); }, 500);
            setInterval(function() {
                if (!document.hidden) Api.ping();
            }, 300000);

            setInterval(function() {
                var now = Date.now();
                var had = false;
                Object.keys(State.occupiedSlots).forEach(function(key) {
                    var rec = State.occupiedSlots[key];
                    if (rec._optimistic && (now - (rec._optimisticAt || 0)) > Config.OPTIMISTIC_TTL) {
                        delete State.occupiedSlots[key];
                        had = true;
                    }
                });
                if (had) {
                    App.rebuildClients();
                    NewRecord.renderSlots();
                    App.updateStats();
                }
            }, 30000);

            App.bootstrap();

            // 🔑 Умный опрос: сначала getVersion, полный bootstrap только если изменилось
            setInterval(function() {
                if (State.isUpdating || document.hidden || Tetradka._hasChanges) return;

                var hasOptimistic = false;
                var now = Date.now();
                Object.keys(State.occupiedSlots).forEach(function(k) {
                    var rec = State.occupiedSlots[k];
                    if (rec._optimistic && (now - (rec._optimisticAt || 0)) < Config.OPTIMISTIC_TTL) {
                        hasOptimistic = true;
                    }
                });
                if (hasOptimistic) return;

                // 🔑 Лёгкий запрос версии (несколько байт вместо килобайт)
                Api.getVersion().then(function(vres) {
                    if (!vres || !vres.ok) return;
                    var newV = String(vres.v || '0');
                    if (State.lastDataVersion === null) {
                        // Первый раз — запомнили, не грузим
                        State.lastDataVersion = newV;
                        return;
                    }
                    if (newV === State.lastDataVersion) {
                        // Ничего не изменилось — не грузим
                        return;
                    }
                    // 🔑 Версия изменилась — грузим полный bootstrap
                    State.lastDataVersion = newV;
                    State.isUpdating = true;
                    App.bootstrap().then(function() { State.isUpdating = false; });
                });
            }, Config.REFRESH_INTERVAL);
        }
    };

    App.init();

})();
