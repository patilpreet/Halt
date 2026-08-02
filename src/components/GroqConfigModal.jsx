import React, { useState, useEffect } from 'react';
import { X, Cpu, ExternalLink, Loader2, Check, AlertTriangle, Sparkles } from 'lucide-react';

export function GroqConfigModal({ apiKey, onSaveApiKey, geminiApiKey, onSaveGeminiApiKey, onClose }) {
  const [inputKey, setInputKey] = useState(apiKey || '');
  const [inputGeminiKey, setInputGeminiKey] = useState(geminiApiKey || '');
  
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  
  const [testingGemini, setTestingGemini] = useState(false);
  const [geminiTestResult, setGeminiTestResult] = useState(null);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSave = () => {
    onSaveApiKey(inputKey.trim());
    onSaveGeminiApiKey(inputGeminiKey.trim());
    onClose();
  };

  const handleTestKey = async () => {
    if (!inputKey.trim()) return;
    setTesting(true);
    setTestResult(null);

    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${inputKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: 'Reply with JSON: {"status":"ok"}' }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
      });

      if (res.ok) {
        setTestResult({ success: true, message: 'Connection verified — llama-3.3-70b active.' });
      } else {
        const error = await res.json();
        setTestResult({ success: false, message: error.error?.message || 'Invalid API key' });
      }
    } catch (err) {
      setTestResult({ success: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  const handleTestGeminiKey = async () => {
    if (!inputGeminiKey.trim()) return;
    setTestingGemini(true);
    setGeminiTestResult(null);

    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${inputGeminiKey.trim()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Reply with JSON: {"status":"ok"}' }] }],
          generationConfig: { responseMimeType: 'application/json' }
        }),
      });

      if (res.ok) {
        setGeminiTestResult({ success: true, message: 'Connection verified — gemini-2.5-flash active.' });
      } else {
        const error = await res.json();
        setGeminiTestResult({ success: false, message: error.error?.message || 'Invalid API key' });
      }
    } catch (err) {
      setGeminiTestResult({ success: false, message: err.message });
    } finally {
      setTestingGemini(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md anim-fade"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="anim-reveal-scale panel scanner w-full max-w-lg p-6 flex flex-col gap-5"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-ink-muted hover:text-danger hover:bg-danger/10 transition-colors z-10"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-xl grid place-items-center flex-shrink-0 border border-lime/30 bg-lime/[0.07] text-lime">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <h2 className="display text-lg text-ink">AI Security Guard Configuration</h2>
            <p className="text-[11px] text-ink-muted mt-0.5">
              Configure API keys to power Layer 2 intent parsing and risk scoring
            </p>
          </div>
        </div>

        {/* Section 1: Groq */}
        <div className="flex flex-col gap-2.5 border border-hair rounded-xl p-4 bg-white/[0.01]">
          <div className="flex items-center justify-between">
            <span className="font-display font-bold text-xs text-lime flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-lime" /> Groq Risk Engine (LLaMA)
            </span>
            <a
              href="https://console.groq.com/keys"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-mono text-[9px] text-lime hover:text-lime-bright transition-colors"
            >
              Get free key <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <input
            type="password"
            placeholder="gsk_…"
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            className="field font-mono text-xs !py-2.5"
          />

          <div className="flex items-center justify-between gap-4">
            <p className="text-[9.5px] text-ink-muted leading-relaxed max-w-[70%]">
              Used as primary LLM. Evaluates spend intent and runs real-time risk scoring.
            </p>
            <button
              onClick={handleTestKey}
              disabled={testing || !inputKey.trim()}
              className="btn btn-ghost !py-1 px-3 !text-[10px] !h-auto flex-shrink-0"
            >
              {testing ? <Loader2 className="w-3 animate-spin" /> : 'Test Groq'}
            </button>
          </div>

          {testResult && (
            <div
              className="anim-fade flex items-start gap-2 rounded-lg border p-2 mt-1"
              style={{
                borderColor: testResult.success ? 'rgba(198,245,60,0.3)' : 'rgba(255,68,56,0.3)',
                background: testResult.success ? 'rgba(198,245,60,0.05)' : 'rgba(255,68,56,0.05)',
              }}
            >
              {testResult.success
                ? <Check className="w-3 h-3 text-lime flex-shrink-0 mt-0.5" />
                : <AlertTriangle className="w-3 h-3 text-danger flex-shrink-0 mt-0.5" />}
              <span
                className="text-[10px] leading-relaxed"
                style={{ color: testResult.success ? 'var(--lime)' : 'var(--danger)' }}
              >
                {testResult.message}
              </span>
            </div>
          )}
        </div>

        {/* Section 2: Gemini */}
        <div className="flex flex-col gap-2.5 border border-hair rounded-xl p-4 bg-white/[0.01]">
          <div className="flex items-center justify-between">
            <span className="font-display font-bold text-xs text-lime flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-lime" /> Google Gemini Engine
            </span>
            <a
              href="https://aistudio.google.com/"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 font-mono text-[9px] text-lime hover:text-lime-bright transition-colors"
            >
              Get free key <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <input
            type="password"
            placeholder="AIzaSy…"
            value={inputGeminiKey}
            onChange={(e) => setInputGeminiKey(e.target.value)}
            className="field font-mono text-xs !py-2.5"
          />

          <div className="flex items-center justify-between gap-4">
            <p className="text-[9.5px] text-ink-muted leading-relaxed max-w-[70%]">
              Used as fallback/primary LLM. Extends analysis coverage.
            </p>
            <button
              onClick={handleTestGeminiKey}
              disabled={testingGemini || !inputGeminiKey.trim()}
              className="btn btn-ghost !py-1 px-3 !text-[10px] !h-auto flex-shrink-0"
            >
              {testingGemini ? <Loader2 className="w-3 animate-spin" /> : 'Test Gemini'}
            </button>
          </div>

          {geminiTestResult && (
            <div
              className="anim-fade flex items-start gap-2 rounded-lg border p-2 mt-1"
              style={{
                borderColor: geminiTestResult.success ? 'rgba(198,245,60,0.3)' : 'rgba(255,68,56,0.3)',
                background: geminiTestResult.success ? 'rgba(198,245,60,0.05)' : 'rgba(255,68,56,0.05)',
              }}
            >
              {geminiTestResult.success
                ? <Check className="w-3 h-3 text-lime flex-shrink-0 mt-0.5" />
                : <AlertTriangle className="w-3 h-3 text-danger flex-shrink-0 mt-0.5" />}
              <span
                className="text-[10px] leading-relaxed"
                style={{ color: geminiTestResult.success ? 'var(--lime)' : 'var(--danger)' }}
              >
                {geminiTestResult.message}
              </span>
            </div>
          )}
        </div>

        <p className="text-[10px] text-ink-muted leading-relaxed text-center px-2">
          If neither key is active, Layer 2 will fall back to local rule analysis.
          The security policies and owner kill switch will still work normally.
        </p>

        <div className="flex gap-2.5 pt-1">
          <button onClick={onClose} className="btn btn-ghost flex-1">
            Cancel
          </button>
          <button onClick={handleSave} className="btn btn-lime flex-1">
            Save & Activate
          </button>
        </div>
      </div>
    </div>
  );
}
