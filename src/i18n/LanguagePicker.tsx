import { useState } from "react";
import { getLanguagePreference, saveLanguagePreference, t, type LanguagePreference } from "./index";
import "./language.css";

export function LanguagePicker({ compact = false }: { compact?: boolean }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  return <div className={`language-picker${compact ? " language-picker--compact" : ""}`}>
    <label>
      <span>{t("界面语言")}</span>
      <select title={t("界面语言")} aria-label={t("界面语言")} defaultValue={getLanguagePreference()} disabled={saving}
        onChange={async (event) => {
          const value = event.target.value as LanguagePreference;
          setSaving(true);
          setError(false);
          try {
            await saveLanguagePreference(value);
            window.location.reload();
          } catch {
            setError(true);
            setSaving(false);
          }
        }}>
        <option value="auto">{compact ? "Auto" : t("跟随浏览器")}</option>
        <option value="zh-CN">{compact ? "中文" : "简体中文"}</option>
        <option value="en">{compact ? "EN" : "English"}</option>
      </select>
    </label>
    {error && <span role="alert">{t("语言设置保存失败，请重试。")}</span>}
  </div>;
}
