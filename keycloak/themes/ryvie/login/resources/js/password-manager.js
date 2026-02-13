// Script pour améliorer la détection des gestionnaires de mots de passe
(function() {
    'use strict';
    
    // Attendre que le DOM soit chargé
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPasswordManager);
    } else {
        initPasswordManager();
    }
    
    function initPasswordManager() {
        // Trouver le champ username/email
        const usernameField = document.querySelector('input[name="username"]') || 
                             document.querySelector('input[type="text"]') ||
                             document.getElementById('username');
        
        if (usernameField) {
            usernameField.setAttribute('autocomplete', 'username');
            usernameField.setAttribute('id', 'username');
            usernameField.setAttribute('name', 'username');
        }
        
        // Trouver le champ password
        const passwordField = document.querySelector('input[name="password"]') || 
                             document.querySelector('input[type="password"]');
        
        if (passwordField) {
            passwordField.setAttribute('autocomplete', 'current-password');
            passwordField.setAttribute('id', 'password');
            passwordField.setAttribute('name', 'password');
        }
        
        // Trouver le formulaire et ajouter les attributs
        const form = document.querySelector('form');
        if (form) {
            form.setAttribute('id', 'kc-form-login');
        }
    }
})();
