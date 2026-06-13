// Routes du point central IA (admin uniquement). Pilote LiteLLM et la connexion
// des apps au fournisseur IA configuré dans Ryvie.
export {};

const express = require('express');
const router = express.Router();
const { verifyToken, isAdmin } = require('../middleware/auth');
const ai = require('../services/aiService');
const claudeCli = require('../services/claudeCliService');

function fail(res: any, error: any) {
  const status = error.status || 500;
  if (status >= 500) console.error('[ai] Erreur:', error.message);
  res.status(status).json({ error: error.message || 'Erreur serveur' });
}

// Shim OpenAI-compatible du fournisseur « Claude CLI ». Appelé par LiteLLM (pas par
// un utilisateur) → pas de verifyToken : il valide lui-même la master key. Lance le
// binaire `claude` local déjà authentifié.
router.post('/ai/cli/v1/chat/completions', claudeCli.chatCompletions);
router.post('/ai/cli/v1/responses', claudeCli.responses);

// GET /api/ai/cli/status — état d'authentification du binaire `claude` local (admin).
router.get('/ai/cli/status', verifyToken, isAdmin, claudeCli.status);

// Connexion interactive (OAuth) du CLI claude pilotée depuis Ryvie (admin) :
// start → renvoie le lien d'autorisation ; complete → réinjecte le code collé.
router.post('/ai/cli/login/start', verifyToken, isAdmin, claudeCli.loginStartHandler);
router.post('/ai/cli/login/complete', verifyToken, isAdmin, claudeCli.loginCompleteHandler);
router.post('/ai/cli/login/cancel', verifyToken, isAdmin, claudeCli.loginCancelHandler);
// POST /api/ai/cli/logout — déconnecte le binaire claude local (admin).
router.post('/ai/cli/logout', verifyToken, isAdmin, claudeCli.logoutHandler);

// GET /api/ai/config — état + fournisseurs disponibles + apps connectables
router.get('/ai/config', verifyToken, isAdmin, async (_req: any, res: any) => {
  try {
    const [apps] = await Promise.all([ai.listApps()]);
    res.status(200).json({
      status: ai.getStatus(),
      providers: ai.getProviders(),
      apps
    });
  } catch (error: any) {
    fail(res, error);
  }
});

// PUT /api/ai/config — définir/maj le fournisseur (provider, apiKey, baseUrl, model)
router.put('/ai/config', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    const result = await ai.setProviderConfig(req.body || {});
    res.status(200).json(result);
  } catch (error: any) {
    fail(res, error);
  }
});

// POST /api/ai/models — liste EN DIRECT les modèles du fournisseur (clé du body
// ou clé enregistrée). POST car peut transporter une clé non encore enregistrée.
router.post('/ai/models', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    const result = await ai.listProviderModels(req.body || {});
    res.status(200).json(result);
  } catch (error: any) {
    fail(res, error);
  }
});

// POST /api/ai/test — vrai appel via LiteLLM jusqu'au fournisseur
router.post('/ai/test', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    const result = await ai.testConnection(req.body || {});
    res.status(200).json(result);
  } catch (error: any) {
    fail(res, error);
  }
});

// POST /api/ai/apps/:id/connect — connecter une app au point IA
router.post('/ai/apps/:id/connect', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    const result = await ai.connectApp(req.params.id);
    res.status(200).json(result);
  } catch (error: any) {
    fail(res, error);
  }
});

// DELETE /api/ai/apps/:id/connect — déconnecter une app
router.delete('/ai/apps/:id/connect', verifyToken, isAdmin, async (req: any, res: any) => {
  try {
    const result = await ai.disconnectApp(req.params.id);
    res.status(200).json(result);
  } catch (error: any) {
    fail(res, error);
  }
});

export = router;
