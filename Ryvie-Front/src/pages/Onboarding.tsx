import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from '../utils/setupAxios';
import '../styles/pages/Onboarding.css';
import urlsConfig from '../config/urls';
import { getCurrentAccessMode } from '../utils/detectAccessMode';

const { getServerUrl } = urlsConfig;

interface OnboardingPage {
  title: string;
  subtitle?: string;
  content: React.ReactNode;
  icon: React.ReactNode;
}

const Onboarding = () => {
  const navigate = useNavigate();
  const [currentPage, setCurrentPage] = useState(0);
  const [isCompleting, setIsCompleting] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

  const closeLightbox = () => setLightboxImage(null);
  const openLightbox = (src: string, alt: string) => setLightboxImage({ src, alt });

  useEffect(() => {
    if (!lightboxImage) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeLightbox();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [lightboxImage]);

  const pages: OnboardingPage[] = [
    {
      title: 'Bienvenue dans votre Ryvie',
      subtitle: 'Votre cloud personnel',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M2 17L12 22L22 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M2 12L12 17L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
      content: (
        <div className="onboarding-content">
          <p className="onboarding-main-text">
            Ryvie est votre espace personnel dans le cloud, conçu pour vous offrir 
            une expérience simple et intuitive.
          </p>
          <div className="onboarding-hero-image">
            <img
              src="/images/assets/ryvie-interface.png"
              alt="Interface Ryvie"
              className="onboarding-clickable-image"
              onClick={() => openLightbox('/images/assets/ryvie-interface.png', 'Interface Ryvie')}
            />
          </div>
        </div>
      )
    },
    {
      title: 'Découvrez l\'App Store',
      subtitle: 'Installez vos applications préférées',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2"/>
          <path d="M9 9H9.01M15 9H15.01M9 15H9.01M15 15H15.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      ),
      content: (
        <div className="onboarding-content">
          <p className="onboarding-main-text">
            L'App Store vous permet d'installer facilement toutes vos applications favorites.
          </p>
          <div className="onboarding-steps">
            <div className="step-item">
              <div className="step-number">1</div>
              <div className="step-text">
                <h4>Parcourez le catalogue</h4>
                <p>Découvrez des centaines d'applications disponibles</p>
              </div>
            </div>
            <div className="step-item">
              <div className="step-number">2</div>
              <div className="step-text">
                <h4>Installez en un clic</h4>
                <p>Chaque application s'installe automatiquement</p>
              </div>
            </div>
            <div className="step-item">
              <div className="step-number">3</div>
              <div className="step-text">
                <h4>Lancez et profitez</h4>
                <p>Vos applications apparaissent sur votre écran d'accueil</p>
              </div>
            </div>
          </div>
        </div>
      )
    },
    {
      title: 'L\'Écosystème Ryvie',
      subtitle: 'Accédez à votre cloud depuis n\'importe où',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2"/>
          <path d="M8 21H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <path d="M12 17V21" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      ),
      content: (
        <div className="onboarding-content onboarding-ecosystem-content">
          <p className="onboarding-main-text">
            Découvrez les applications qui étendent les capacités de votre Ryvie.
          </p> 
          <div className="onboarding-apps-ecosystem">
            <div className="ecosystem-app">
              <img 
                src="/images/assets/ryvie-desktop.png" 
                alt="Ryvie Desktop" 
                className="app-screenshot app-screenshot-desktop onboarding-clickable-image"
                onClick={() => openLightbox('/images/assets/ryvie-desktop.png', 'Ryvie Desktop')}
              />
              <div className="app-info">
                <h4>Ryvie Desktop</h4>
                <p>
                  Accédez à votre Ryvie depuis n'importe où dans le monde. 
                  Ryvie Desktop établit une connexion ultra-sécurisée entre votre appareil 
                  et votre serveur personnel, où que vous soyez.
                </p>
              </div>
            </div>
            <div className="ecosystem-app">
              <img 
                src="/images/assets/ryvie-connect.png" 
                alt="Ryvie Connect" 
                className="app-screenshot app-screenshot-mobile onboarding-clickable-image"
                onClick={() => openLightbox('/images/assets/ryvie-connect.png', 'Ryvie Connect')}
              />
              <div className="app-info">
                <h4>Ryvie Connect</h4>
                <p>
                  Disponible dans l'App Store, Ryvie Connect vous permet de vous connecter à
                  votre Ryvie depuis votre smartphone.
                </p>
              </div>
            </div>
            <div className="ecosystem-app">
              <img 
                src="/images/assets/rpictures.png" 
                alt="rPictures" 
                className="app-screenshot app-screenshot-mobile onboarding-clickable-image"
                onClick={() => openLightbox('/images/assets/rpictures.png', 'rPictures')}
              />
              <div className="app-info">
                <h4>rPictures</h4>
                <p>
                  Sauvegardez automatiquement vos photos et vidéos sur votre Ryvie. 
                  rPictures est également disponible dans l'App Store.
                </p>
              </div>
            </div>
          </div>
        </div>
      )
    },
    {
      title: 'Gérez Vos Applications',
      subtitle: 'Contrôlez facilement vos apps installées',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 5V19M5 12H19" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2"/>
        </svg>
      ),
      content: (
        <div className="onboarding-content">
          <p className="onboarding-main-text">
            Un simple clic droit sur une application vous donne accès à toutes les options de gestion.
          </p>
          <div className="onboarding-right-click">
            <div className="right-click-demo">
              <img 
                src="/images/assets/right-click-menu.png" 
                alt="Menu clic droit" 
                className="demo-screenshot onboarding-clickable-image"
                onClick={() => openLightbox('/images/assets/right-click-menu.png', 'Menu clic droit')}
              />
            </div>
            <div className="right-click-actions">
              <div className="action-item">
                <div className="action-icon">▶️</div>
                <div className="action-text">
                  <h4>Démarrer / Arrêter</h4>
                  <p>Contrôlez l'état de vos applications en un clic</p>
                </div>
              </div>
              <div className="action-item">
                <div className="action-icon">🔄</div>
                <div className="action-text">
                  <h4>Redémarrer</h4>
                  <p>Relancez une application qui ne répond plus</p>
                </div>
              </div>
              <div className="action-item">
                <div className="action-icon">🗑️</div>
                <div className="action-text">
                  <h4>Désinstaller</h4>
                  <p>Supprimez les applications dont vous n'avez plus besoin</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )
    },
    {
      title: 'Personnalisez Votre Espace',
      subtitle: 'Faites de Ryvie votre chez-vous',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2"/>
          <path d="M12 1V3M12 21V23M4.22 4.22L5.64 5.64M18.36 18.36L19.78 19.78M1 12H3M21 12H23M4.22 19.78L5.64 18.36M18.36 5.64L19.78 4.22" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      ),
      content: (
        <div className="onboarding-content">
          <p className="onboarding-main-text">
            Personnalisez votre expérience pour qu'elle vous ressemble.
          </p>
          <div className="onboarding-customization">
            <div className="custom-item">
              <div className="custom-icon">🖼️</div>
              <div className="custom-text">
                <h4>Fond d'écran</h4>
                <p>Choisissez parmi nos fonds ou importez le vôtre</p>
              </div>
            </div>
            <div className="custom-item">
              <div className="custom-icon">🌓</div>
              <div className="custom-text">
                <h4>Mode sombre</h4>
                <p>Activez le thème sombre pour plus de confort</p>
              </div>
            </div>
            <div className="custom-item">
              <div className="custom-icon">📍</div>
              <div className="custom-text">
                <h4>Organisation</h4>
                <p>Déplacez et organisez vos applications comme vous le souhaitez</p>
              </div>
            </div>
            <div className="custom-item">
              <div className="custom-icon">🌤️</div>
              <div className="custom-text">
                <h4>Widgets</h4>
                <p>Ajoutez des widgets météo, stockage, et plus encore</p>
              </div>
            </div>
          </div>
        </div>
      )
    },
    {
      title: 'Vous êtes prêt !',
      subtitle: 'Commencez votre aventure avec Ryvie',
      icon: (
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M22 11.08V12C21.9988 14.1564 21.3005 16.2547 20.0093 17.9818C18.7182 19.7088 16.9033 20.9725 14.8354 21.5839C12.7674 22.1953 10.5573 22.1219 8.53447 21.3746C6.51168 20.6273 4.78465 19.2461 3.61096 17.4371C2.43727 15.628 1.87979 13.4881 2.02168 11.3363C2.16356 9.18455 2.99721 7.13631 4.39828 5.49706C5.79935 3.85781 7.69279 2.71537 9.79619 2.24013C11.8996 1.7649 14.1003 1.98232 16.07 2.85999" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M22 4L12 14.01L9 11.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
      content: (
        <div className="onboarding-content">
          <p className="onboarding-main-text">
            Vous avez maintenant toutes les clés pour profiter pleinement de Ryvie !
          </p>
          <div className="onboarding-final">
            <div className="final-tips">
              <h4>Quelques conseils pour bien démarrer :</h4>
              <ul>
                <li>Explorez l'App Store pour installer vos premières applications</li>
                <li>Personnalisez votre fond d'écran dans les paramètres</li>
                <li>Organisez vos applications en les déplaçant sur l'écran</li>
                <li>Consultez la documentation si vous avez des questions</li>
              </ul>
            </div>
            <div className="final-cta">
              <p className="final-message">
                Prêt à découvrir votre nouvel espace personnel ?
              </p>
            </div>
          </div>
        </div>
      )
    }
  ];

  const handleNext = () => {
    if (currentPage < pages.length - 1) {
      setCurrentPage(currentPage + 1);
    }
  };

  const handlePrevious = () => {
    if (currentPage > 0) {
      setCurrentPage(currentPage - 1);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      const accessMode = getCurrentAccessMode() || 'private';
      const serverUrl = getServerUrl(accessMode);
      
      await axios.post(`${serverUrl}/api/user/complete-onboarding`);
      
      navigate('/home', { replace: true });
    } catch (error) {
      console.error('Erreur lors de la complétion de l\'onboarding:', error);
      navigate('/home', { replace: true });
    }
  };

  const handleSkip = async () => {
    await handleComplete();
  };

  const currentPageData = pages[currentPage];
  const isLastPage = currentPage === pages.length - 1;

  return (
    <div className="onboarding-container">
      <div className="onboarding-modal">
        <div className="onboarding-alpha-badge">Alpha</div>
        <button className="onboarding-skip" onClick={handleSkip}>
          Passer
        </button>
        
        <div className="onboarding-header">
          <div className="onboarding-icon">
            {currentPageData.icon}
          </div>
          <h1 className="onboarding-title">{currentPageData.title}</h1>
          {currentPageData.subtitle && (
            <p className="onboarding-subtitle">{currentPageData.subtitle}</p>
          )}
        </div>

        <div className="onboarding-body">
          {currentPageData.content}
        </div>

        <div className="onboarding-footer">
          <div className="onboarding-dots">
            {pages.map((_, index) => (
              <div
                key={index}
                className={`dot ${index === currentPage ? 'active' : ''}`}
                onClick={() => setCurrentPage(index)}
              />
            ))}
          </div>

          <div className="onboarding-actions">
            {currentPage > 0 && (
              <button className="onboarding-btn secondary" onClick={handlePrevious}>
                Précédent
              </button>
            )}
            {!isLastPage ? (
              <button className="onboarding-btn primary" onClick={handleNext}>
                Suivant
              </button>
            ) : (
              <button 
                className="onboarding-btn primary complete" 
                onClick={handleComplete}
                disabled={isCompleting}
              >
                {isCompleting ? 'Chargement...' : 'Commencer'}
              </button>
            )}
          </div>
        </div>
      </div>

      {lightboxImage && (
        <div className="onboarding-lightbox" onClick={closeLightbox}>
          <div className="onboarding-lightbox-backdrop" />
          <div className="onboarding-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button
              className="onboarding-lightbox-close"
              type="button"
              onClick={closeLightbox}
              aria-label="Fermer"
            >
              ×
            </button>
            <img src={lightboxImage.src} alt={lightboxImage.alt} />
          </div>
        </div>
      )}
    </div>
  );
};

export default Onboarding;
