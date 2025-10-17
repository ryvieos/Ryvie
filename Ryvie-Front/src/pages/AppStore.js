import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import '../styles/Transitions.css';

const AppStore = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    // Simuler un chargement
    const timer = setTimeout(() => {
      setFadeOut(true);
      setTimeout(() => setLoading(false), 300); // Attendre la fin du fade-out
    }, 600);
    
    return () => clearTimeout(timer);
  }, []);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      flexDirection: 'column',
      textAlign: 'center',
      padding: '24px',
      color: '#000',
      background: '#fff',
      position: 'relative'
    }}>
      {/* Spinner overlay avec fade-out */}
      {loading && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: '20px',
          background: '#fff',
          opacity: fadeOut ? 0 : 1,
          transition: 'opacity 0.3s ease-out',
          zIndex: 10
        }}>
          <div className="spinner" style={{
            width: '50px',
            height: '50px',
            border: '4px solid rgba(0, 0, 0, 0.1)',
            borderTop: '4px solid #1976d2',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }}></div>
          <p style={{ color: '#000', fontSize: 16, opacity: 0.7 }}>Chargement...</p>
        </div>
      )}

      {/* Contenu principal avec fade-in */}
      <div style={{
        opacity: loading ? 0 : 1,
        transform: loading ? 'scale(0.95)' : 'scale(1)',
        transition: 'opacity 0.4s ease-out, transform 0.4s ease-out',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center'
      }}>
        <img src={require('../icons/app-AppStore.jpeg')} alt="App Store" style={{ 
          width: 120, 
          height: 120, 
          borderRadius: 24, 
          marginBottom: 24
        }} />
        <h1 style={{ 
          margin: 0, 
          fontSize: 36
        }}>App Store</h1>
        <p style={{ 
          marginTop: 12, 
          fontSize: 20, 
          opacity: 0.8
        }}>Ça arrive bientôt</p>
      </div>

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default AppStore;
