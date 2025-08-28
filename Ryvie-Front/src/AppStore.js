import React from 'react';
import { useNavigate } from 'react-router-dom';
import './styles/Transitions.css';

const AppStore = () => {
  const navigate = useNavigate();
  return (
    <div className="appstore-container slide-enter-active" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      flexDirection: 'column',
      textAlign: 'center',
      padding: '24px',
      color: '#000'
    }}>
      <img src={require('./icons/app-AppStore.jpeg')} alt="App Store" style={{ width: 120, height: 120, borderRadius: 24, marginBottom: 24 }} />
      <h1 style={{ margin: 0, fontSize: 36 }}>App Store</h1>
      <p style={{ marginTop: 12, fontSize: 20, opacity: 0.8 }}>Ça arrive bientôt</p>
      <div style={{
        maxWidth: 760,
        marginTop: 16,
        color: '#000',
        opacity: 0.9,
        fontSize: 16,
        lineHeight: 1.5
      }}>

      </div>

    </div>
  );
};

export default AppStore;
