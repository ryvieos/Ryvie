import React from 'react';
import ReactDOM from 'react-dom';

/**
 * Modal — socle commun des fenêtres d'app (comptes, réglages, config…).
 *
 * Centralise UNE fois pour toutes :
 *  - le portail (`createPortal` vers `document.body`) ;
 *  - le PIÈGE D'ÉVÉNEMENTS : avec un portail, React refait remonter les événements
 *    par l'arbre REACT (pas le DOM). Sans blocage, une touche Entrée ou un
 *    relâchement de souris hors zone remonte jusqu'à l'icône de l'app et l'ouvre.
 *    On stoppe donc tous les événements clavier/souris/pointeur au bord du modal ;
 *  - Échap pour fermer + clic extérieur sécurisé (uniquement si le clic a COMMENCÉ
 *    sur l'overlay → une sélection de texte relâchée dehors ne ferme pas) ;
 *  - le thème clair/sombre partagé (variables `--rv-*`, classes `.rv-skel`/`.rv-spinner`).
 *
 * Les composants enfants ne fournissent que le CONTENU (children) et stylent avec
 * les variables `--rv-*`.
 */

interface ModalProps {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  /** Largeur max en px (défaut 520). */
  width?: number;
  /** Boutons additionnels dans l'en-tête, avant la croix (ex. ⓘ). */
  headerActions?: React.ReactNode;
  /** Contenu inséré entre l'en-tête et le corps (toast, panneau d'info…). */
  banner?: React.ReactNode;
  /** Surcharge du style du corps (ex. `display:flex` pour l'éditeur). */
  bodyStyle?: React.CSSProperties;
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

const Modal: React.FC<ModalProps> = ({ title, onClose, children, width = 520, headerActions, banner, bodyStyle }) => {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const downOnOverlayRef = React.useRef(false);

  // Focus le modal au montage pour que Échap fonctionne même sans champ focus.
  React.useEffect(() => {
    boxRef.current?.focus();
  }, []);

  const onOverlayMouseDown = (e: React.MouseEvent) => {
    downOnOverlayRef.current = e.target === e.currentTarget;
    stop(e);
  };
  const onOverlayClick = (e: React.MouseEvent) => {
    stop(e);
    // Ne ferme que si le geste a commencé ET fini sur l'overlay (pas une sélection).
    if (downOnOverlayRef.current && e.target === e.currentTarget) onClose();
  };
  const onOverlayKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') onClose();
  };

  return ReactDOM.createPortal(
    <div
      style={styles.overlay}
      onClick={onOverlayClick}
      onMouseDown={onOverlayMouseDown}
      onMouseUp={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onKeyDown={onOverlayKeyDown}
      onKeyUp={stop}
      onContextMenu={stop}
    >
      <style>{themeStyle}</style>
      <div
        ref={boxRef}
        tabIndex={-1}
        className="rv-modal"
        style={{ ...styles.modal, width: `min(${width}px, 94vw)` }}
        onClick={stop}
        onMouseDown={stop}
        onMouseUp={stop}
        onPointerDown={stop}
        onPointerUp={stop}
        onContextMenu={stop}
      >
        <div style={styles.header}>
          <h3 style={styles.title}>{title}</h3>
          <div style={styles.headerActions}>
            {headerActions}
            <button style={styles.closeBtn} onClick={onClose} aria-label="Fermer">✕</button>
          </div>
        </div>

        {banner}

        <div style={{ ...styles.body, ...bodyStyle }}>{children}</div>
      </div>
    </div>,
    document.body
  );
};

// Thème clair par défaut, override sombre via prefers-color-scheme (cf. UpdateModal).
const themeStyle = `
  .rv-modal {
    --rv-bg: #ffffff;
    --rv-fg: #0f172a;
    --rv-muted: #64748b;
    --rv-border: rgba(15,23,42,0.10);
    --rv-row-border: rgba(15,23,42,0.07);
    --rv-input-bg: #f1f5f9;
    --rv-input-border: rgba(15,23,42,0.14);
    --rv-skel-base: rgba(15,23,42,0.07);
    --rv-skel-shine: rgba(15,23,42,0.14);
    outline: none;
  }
  @media (prefers-color-scheme: dark) {
    .rv-modal {
      --rv-bg: #1f2430;
      --rv-fg: #e6e8ee;
      --rv-muted: #9aa3b2;
      --rv-border: rgba(255,255,255,0.08);
      --rv-row-border: rgba(255,255,255,0.06);
      --rv-input-bg: #161b24;
      --rv-input-border: rgba(255,255,255,0.12);
      --rv-skel-base: rgba(255,255,255,0.07);
      --rv-skel-shine: rgba(255,255,255,0.15);
    }
  }
  .rv-skel {
    background: linear-gradient(90deg, var(--rv-skel-base) 25%, var(--rv-skel-shine) 37%, var(--rv-skel-base) 63%);
    background-size: 400% 100%;
    animation: rv-shimmer 1.4s ease infinite;
  }
  @keyframes rv-shimmer {
    0% { background-position: 100% 0; }
    100% { background-position: -100% 0; }
  }
  .rv-spinner { animation: rv-spin 1s linear infinite; }
  @keyframes rv-spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
`;

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10001, backdropFilter: 'blur(2px)',
  },
  modal: {
    maxHeight: '86vh', overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
    background: 'var(--rv-bg)', color: 'var(--rv-fg)', borderRadius: 14,
    boxShadow: '0 20px 60px rgba(0,0,0,0.25)', border: '1px solid var(--rv-border)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 20px', borderBottom: '1px solid var(--rv-border)',
  },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  headerActions: { display: 'flex', alignItems: 'center', gap: 4 },
  closeBtn: {
    background: 'transparent', border: 'none', color: 'var(--rv-muted)',
    fontSize: 18, cursor: 'pointer', lineHeight: 1,
  },
  body: { padding: '12px 20px 20px', overflowY: 'auto' },
};

export default Modal;
