/**
 * Circular 24-hour time filter. No dependencies.
 *
 * import { TimeDial } from './time-dial.js';
 * const dial = new TimeDial(element, {
 *   start: 0, end: 24,
 *   onChange: ({ start, end }) => updateMap(start, end),
 * });
 * dial.setRange(22, 6); // Programmatic updates do not call onChange.
 * dial.value;          // { start: 22, end: 6 }; a fresh object each time.
 * dial.destroy();      // Remove listeners and rendered content.
 *
 * Values use whole hours. Start accepts 0–23; end accepts 0–24.
 * Midnight end values 0 and 24 are equivalent. Equal endpoints represent
 * the entire day. Overnight ranges include the hours after midnight.
 * A consumer can match an hour h using:
 *   const endHour = end % 24;
 *   const allDay = start === endHour;
 *   const matches = allDay || (start < endHour
 *     ? h >= start && h < endHour : h >= start || h < endHour);
 *
 * Load time-dial.css separately. The component fills its parent width.
 */
export class TimeDial {
  constructor(element, { start = 0, end = 24, onChange = () => {} } = {}) {
    if (!element || element.nodeType !== 1) {
      throw new TypeError('TimeDial necesita un elemento contenedor.');
    }
    this.element = element;
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this._start = this._hour(start, 23);
    this._end = this._hour(end, 24);
    this._drag = null;
    this._abort = new AbortController();
    this._render();
    this._listen();
    this._update();
  }

  get value() {
    return { start: this._start, end: this._end };
  }

  setRange(start, end) {
    this._start = this._hour(start, 23);
    this._end = this._hour(end, 24);
    this._update();
  }

  destroy() {
    this._abort.abort();
    this._drag = null;
    this.element.replaceChildren();
    this.element.classList.remove('time-dial');
  }

  _hour(value, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(max, Math.round(n)));
  }

  _format(hour) {
    return `${String(hour % 24).padStart(2, '0')}:00`;
  }

  _point(hour, angleOffset = 0) {
    const angle = (hour / 24) * Math.PI * 2 - Math.PI / 2 + angleOffset;
    return { x: 100 + 68 * Math.cos(angle), y: 100 + 68 * Math.sin(angle) };
  }

  _render() {
    const ticks = Array.from({ length: 24 }, (_, hour) => {
      const a = (hour / 24) * Math.PI * 2 - Math.PI / 2;
      const major = hour % 6 === 0;
      const r1 = major ? 77 : 74;
      const r2 = major ? 82 : 78;
      return `<line x1="${100 + r1 * Math.cos(a)}" y1="${100 + r1 * Math.sin(a)}" x2="${100 + r2 * Math.cos(a)}" y2="${100 + r2 * Math.sin(a)}" class="time-dial__tick${major ? ' time-dial__tick--major' : ''}" />`;
    }).join('');
    const options = (max) => Array.from({ length: max + 1 }, (_, hour) =>
      `<option value="${hour}">${this._format(hour)}${hour === 24 ? ' (+1 día)' : ''}</option>`
    ).join('');

    this.element.classList.add('time-dial');
    this.element.innerHTML = `
      <div class="time-dial__heading">Horario</div>
      <div class="time-dial__face">
        <svg class="time-dial__svg" viewBox="0 0 200 200" role="group" aria-label="Filtro de horario de 24 horas">
          <circle class="time-dial__track" cx="100" cy="100" r="68" />
          <circle class="time-dial__selection" cx="100" cy="100" r="68" transform="rotate(-90 100 100)" />
          <g aria-hidden="true">${ticks}
            <text x="100" y="12" text-anchor="middle" class="time-dial__hour">0</text>
            <text x="191" y="104" text-anchor="middle" class="time-dial__hour">6</text>
            <text x="100" y="195" text-anchor="middle" class="time-dial__hour">12</text>
            <text x="9" y="104" text-anchor="middle" class="time-dial__hour">18</text>
          </g>
          <circle class="time-dial__hit-track" cx="100" cy="100" r="68" aria-hidden="true" />
          <circle class="time-dial__handle time-dial__handle--start" data-handle="start" r="9" tabindex="0" role="slider" aria-label="Hora de inicio" aria-valuemin="0" aria-valuemax="23" aria-orientation="horizontal" />
          <circle class="time-dial__handle time-dial__handle--end" data-handle="end" r="9" tabindex="0" role="slider" aria-label="Hora de fin" aria-valuemin="0" aria-valuemax="24" aria-orientation="horizontal" />
        </svg>
        <div class="time-dial__display" aria-hidden="true">
          <strong class="time-dial__display-start"></strong>
          <span class="time-dial__display-end"></span>
        </div>
      </div>
      <div class="time-dial__inputs">
        <label>Desde<select class="time-dial__select" data-select="start" aria-label="Hora de inicio">${options(23)}</select></label>
        <span class="time-dial__input-arrow" aria-hidden="true">→</span>
        <label>Hasta<select class="time-dial__select" data-select="end" aria-label="Hora de fin">${options(24)}</select></label>
      </div>
      <p class="time-dial__status" role="status" aria-live="polite" aria-atomic="true"></p>
    `;
    this.svg = this.element.querySelector('.time-dial__svg');
    this.arc = this.element.querySelector('.time-dial__selection');
    this.handles = {
      start: this.element.querySelector('[data-handle="start"]'),
      end: this.element.querySelector('[data-handle="end"]'),
    };
    this.selects = {
      start: this.element.querySelector('[data-select="start"]'),
      end: this.element.querySelector('[data-select="end"]'),
    };
    this.displayStart = this.element.querySelector('.time-dial__display-start');
    this.displayEnd = this.element.querySelector('.time-dial__display-end');
    this.status = this.element.querySelector('.time-dial__status');
  }

  _listen() {
    const opts = { signal: this._abort.signal };
    this.svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || this._drag) return;
      const handle = event.target.closest('[data-handle]');
      const track = event.target.classList.contains('time-dial__hit-track');
      if (!handle && !track) return;
      event.preventDefault();
      const hour = this._pointerHour(event);
      const name = handle?.dataset.handle || this._nearestHandle(hour);
      this._drag = { name, pointerId: event.pointerId };
      this.svg.setPointerCapture(event.pointerId);
      this.handles[name].focus({ preventScroll: true });
      this.element.classList.add('time-dial--dragging');
      this._setUserHour(name, hour);
    }, opts);

    this.svg.addEventListener('pointermove', (event) => {
      if (!this._drag || this._drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      this._setUserHour(this._drag.name, this._pointerHour(event));
    }, opts);

    const endDrag = (event) => {
      if (!this._drag || this._drag.pointerId !== event.pointerId) return;
      this._drag = null;
      this.element.classList.remove('time-dial--dragging');
      if (this.svg.hasPointerCapture(event.pointerId)) {
        this.svg.releasePointerCapture(event.pointerId);
      }
    };
    this.svg.addEventListener('pointerup', endDrag, opts);
    this.svg.addEventListener('pointercancel', endDrag, opts);
    this.svg.addEventListener('lostpointercapture', endDrag, opts);

    for (const name of ['start', 'end']) {
      this.handles[name].addEventListener('keydown', (event) => {
        const current = name === 'start' ? this._start : this._end % 24;
        let next;
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          next = (current + 1) % 24;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          next = (current + 23) % 24;
        } else if (event.key === 'Home') {
          next = 0;
        } else if (event.key === 'End') {
          next = name === 'start' ? 23 : 24;
        } else return;
        event.preventDefault();
        this._setUserHour(name, next, event.key === 'Home');
      }, opts);
      this.selects[name].addEventListener('change', (event) => {
        this._setUserHour(name, Number(event.target.value), true);
      }, opts);
    }
  }

  _pointerHour(event) {
    // SVG coordinates account for scale and preserveAspectRatio letterboxing.
    const matrix = this.svg.getScreenCTM();
    if (!matrix) return 0;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const angle = Math.atan2(p.y - 100, p.x - 100) + Math.PI / 2;
    return ((Math.round((angle / (2 * Math.PI)) * 24) % 24) + 24) % 24;
  }

  _nearestHandle(hour) {
    const distance = (value) => {
      const diff = Math.abs(hour - value % 24);
      return Math.min(diff, 24 - diff);
    };
    // Prefer end for equal distances; dragging a full-day track then narrows it.
    return distance(this._start) < distance(this._end) ? 'start' : 'end';
  }

  _setUserHour(name, hour, preserveZero = false) {
    const value = name === 'end' && hour === 0 && !preserveZero ? 24 : hour;
    const key = name === 'start' ? '_start' : '_end';
    if (this[key] === value) return;
    this[key] = this._hour(value, name === 'start' ? 23 : 24);
    this._update();
    this.onChange(this.value);
  }

  _update() {
    const duration = ((this._end % 24) - this._start + 24) % 24 || 24;
    const allDay = duration === 24;
    const circumference = 2 * Math.PI * 68;
    const length = (duration / 24) * circumference;
    this.arc.setAttribute('stroke-dasharray', `${length} ${circumference - length}`);
    this.arc.setAttribute('stroke-dashoffset', `${-(this._start / 24) * circumference}`);
    // Offset coincident midnight handles slightly so either remains draggable.
    const offset = allDay ? 0.085 : 0;
    for (const name of ['start', 'end']) {
      const hour = name === 'start' ? this._start : this._end;
      const p = this._point(hour, name === 'start' ? -offset : offset);
      const handle = this.handles[name];
      handle.setAttribute('cx', p.x);
      handle.setAttribute('cy', p.y);
      handle.setAttribute('aria-valuenow', hour);
      handle.setAttribute('aria-valuetext', `${this._format(hour)}${hour === 24 ? ', medianoche' : ''}`);
      this.selects[name].value = String(hour);
    }
    this.displayStart.textContent = allDay ? 'Todo' : this._format(this._start);
    this.displayEnd.textContent = allDay ? 'el día' : `a ${this._format(this._end)}`;
    this.status.textContent = allDay
      ? 'Todo el día · 24 horas'
      : `${this._format(this._start)} a ${this._format(this._end)} · ${duration} ${duration === 1 ? 'hora' : 'horas'}${this._end % 24 < this._start ? ' · cruza medianoche' : ''}`;
  }
}

