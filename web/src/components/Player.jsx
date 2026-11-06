import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { fmtTime, speakerColor } from '../util.js';

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

const Player = forwardRef(function Player({ src, segments = [], chapters = [], duration: knownDuration = 0, speakers = [], onTime, onPip }, ref) {
  const box = useRef(null), vid = useRef(null), scrub = useRef(null), idleTimer = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(knownDuration);
  const [buffered, setBuffered] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(true);
  const [menu, setMenu] = useState(false);
  const [idle, setIdle] = useState(false);
  const [hover, setHover] = useState(null);
  const [drag, setDrag] = useState(false);
  const [started, setStarted] = useState(false);

  const total = dur || knownDuration || 1;
  const seek = useCallback((t) => {
    const v = vid.current; if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, (v.duration || total) - 0.05));
    setTime(v.currentTime); onTime?.(v.currentTime);
  }, [total, onTime]);
  const toggle = useCallback(() => { const v = vid.current; if (!v) return; v.paused ? v.play().catch(() => {}) : v.pause(); setStarted(true); }, []);

  useImperativeHandle(ref, () => ({ seek: (t, play = true) => { seek(t); if (play) vid.current?.play().catch(() => {}); setStarted(true); }, el: () => vid.current }), [seek]);

  // Tell the page when the video floats in its own window, so it can give the space to the transcript.
  useEffect(() => {
    const v = vid.current; if (!v) return;
    const on = () => onPip?.(true), off = () => onPip?.(false);
    v.addEventListener('enterpictureinpicture', on); v.addEventListener('leavepictureinpicture', off);
    return () => { v.removeEventListener('enterpictureinpicture', on); v.removeEventListener('leavepictureinpicture', off); if (document.pictureInPictureElement === v) onPip?.(false); };
  }, [src, onPip]);
  useEffect(() => { if (vid.current) vid.current.playbackRate = rate; }, [rate]);
  useEffect(() => { if (vid.current) { vid.current.volume = volume; vid.current.muted = muted; } }, [volume, muted]);

  const wake = () => { setIdle(false); clearTimeout(idleTimer.current); idleTimer.current = setTimeout(() => setIdle(true), 2500); };
  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const at = (e) => { const r = scrub.current.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total; };
  const down = (e) => { scrub.current.setPointerCapture(e.pointerId); setDrag(true); seek(at(e)); };
  const move = (e) => { const t = at(e); setHover({ t, x: ((e.clientX - scrub.current.getBoundingClientRect().left) / scrub.current.offsetWidth) * 100 }); if (drag) seek(t); };

  const key = (e) => {
    if (e.target.tagName === 'INPUT') return;
    const v = vid.current, k = e.key.toLowerCase();
    const map = {
      ' ': toggle, k: toggle, j: () => seek(v.currentTime - 10), l: () => seek(v.currentTime + 10),
      arrowleft: () => seek(v.currentTime - 5), arrowright: () => seek(v.currentTime + 5),
      arrowup: () => setVolume((x) => Math.min(1, x + 0.1)), arrowdown: () => setVolume((x) => Math.max(0, x - 0.1)),
      m: () => setMuted((x) => !x), c: () => setCaptions((x) => !x),
      f: () => (document.fullscreenElement ? document.exitFullscreen() : box.current.requestFullscreen?.()),
    };
    if (map[k]) { e.preventDefault(); map[k](); wake(); }
  };

  if (!src) {
    return <div className="player empty-media"><div style={{ textAlign: 'center' }}><Icon name="video" size={36} /><div style={{ marginTop: 8 }}>No video for this meeting</div></div></div>;
  }

  const current = captions && segments.find((s) => time >= s.start && time <= s.end + 0.4);
  const pct = (t) => `${(t / total) * 100}%`;
  // Chapters split the rail into segments (like YouTube); without chapters it is one bar.
  const parts = (() => {
    const c = [...chapters].filter((x) => Number.isFinite(x.start)).sort((a, b) => a.start - b.start);
    if (!c.length) return [{ start: 0, end: total }];
    if (c[0].start > 0) c.unshift({ start: 0, title: '' });
    return c.map((x, i) => ({ ...x, end: c[i + 1]?.start ?? total }));
  })();
  const part = (x, a, b) => `${Math.max(0, Math.min(1, (x - a) / Math.max(0.001, b - a))) * 100}%`;
  const nowChapter = chapters.length ? [...parts].reverse().find((c) => c.start <= time)?.title : '';

  return (
    <div ref={box} className={`player ${idle ? 'idle' : ''} ${playing ? 'playing' : ''}`} tabIndex={0} onKeyDown={key} onMouseMove={wake} onMouseLeave={() => setIdle(playing)}>
      <video
        ref={vid} src={src} preload="metadata" playsInline onClick={toggle} onDoubleClick={() => box.current.requestFullscreen?.()}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => Number.isFinite(e.target.duration) && setDur(e.target.duration)}
        onTimeUpdate={(e) => { setTime(e.target.currentTime); onTime?.(e.target.currentTime); const b = e.target.buffered; if (b.length) setBuffered(b.end(b.length - 1)); }}
        onProgress={(e) => { const b = e.target.buffered; if (b.length) setBuffered(b.end(b.length - 1)); }}
      />
      {!started && !playing && <button className="bigplay" onClick={toggle} aria-label="Play"><span><Icon name="play" size={30} /></span></button>}
      {current && <div className="caption"><b style={{ opacity: 0.7, fontWeight: 600 }}>{current.speaker}: </b>{current.text.length > 160 ? current.text.slice(0, 157) + '…' : current.text}</div>}

      <div className="controls" onClick={(e) => e.stopPropagation()}>
        <div ref={scrub} className={`scrub ${drag ? 'drag' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={() => setDrag(false)} onPointerLeave={() => setHover(null)} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(time)}>
          <div className="rail">{parts.map((c, i) => (
            <div key={i} className="cseg" style={{ left: pct(c.start), width: `calc(${pct(c.end - c.start)} - ${i < parts.length - 1 ? 3 : 0}px)` }}><div className="buf" style={{ width: part(buffered, c.start, c.end) }} /><div className="done" style={{ width: part(time, c.start, c.end) }} /></div>
          ))}</div>
          <div className="knob" style={{ left: pct(time) }} />
          {hover && <div className="tip" style={{ left: `${hover.x}%` }}>{fmtTime(hover.t)}{chapters.length ? <div style={{ opacity: 0.7 }}>{[...chapters].reverse().find((c) => c.start <= hover.t)?.title}</div> : null}</div>}
        </div>
        <div className="ctl">
          <button onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} size={20} /></button>
          <button onClick={() => seek(time - 10)} aria-label="Back 10 seconds"><Icon name="back" size={20} /></button>
          <button onClick={() => seek(time + 10)} aria-label="Forward 10 seconds"><Icon name="fwd" size={20} /></button>
          <time>{fmtTime(time)} / {fmtTime(total)}</time>
          {nowChapter && <span className="nowchap">{nowChapter}</span>}
          <span style={{ flex: 1 }} />
          <button onClick={() => setMuted((m) => !m)} aria-label="Mute"><Icon name={muted || volume === 0 ? 'mute' : 'volume'} /></button>
          <input className="vol" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(e) => { setVolume(+e.target.value); setMuted(false); }} aria-label="Volume" />
          <button className={captions ? 'on' : ''} onClick={() => setCaptions((c) => !c)} aria-label="Captions"><Icon name="cc" /></button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => setMenu((m) => !m)} aria-label="Speed">{rate}×</button>
            {menu && <div className="menu">{RATES.map((r) => <button key={r} style={{ color: r === rate ? 'var(--yellow)' : '#fff' }} onClick={() => { setRate(r); setMenu(false); }}>{r}×{r === rate && ' ✓'}</button>)}</div>}
          </div>
          {document.pictureInPictureEnabled && <button onClick={() => (document.pictureInPictureElement ? document.exitPictureInPicture() : vid.current.requestPictureInPicture())} aria-label="Picture in picture"><Icon name="pip" /></button>}
          <button onClick={() => (document.fullscreenElement ? document.exitFullscreen() : box.current.requestFullscreen?.())} aria-label="Full screen"><Icon name="full" /></button>
        </div>
      </div>
    </div>
  );
});
export default Player;
