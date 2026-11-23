import React, { useEffect, useState, useCallback } from 'react';
import {
  SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity, Image,
  StyleSheet, useColorScheme, Alert, Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import { getLocales } from 'expo-localization';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: false, shouldSetBadge: false }),
});

// ---------- i18n ----------
const T = {
  ru: { ph: 'Вставьте ссылки на YouTube или TikTok — по одной на строку', find: 'Найти', dl: 'Скачать',
    queued: 'В очереди', processing: 'Обработка…', saving: 'Сохранение…', done: 'Сохранено в галерею',
    video: 'MP4', audio: 'MP3 (аудио)', history: 'История', empty: 'Пока пусто', server: 'Адрес сервера',
    notif: 'Загрузка завершена', e: { unsupported: 'Ссылка не поддерживается', private: 'Видео приватное',
    login_required: 'Нужен вход в аккаунт', age_restricted: 'Видео с возрастным ограничением',
    geo_blocked: 'Недоступно в вашем регионе', unavailable: 'Видео удалено или недоступно',
    network: 'Нет связи с сервером. Проверьте адрес в настройках', unknown: 'Не удалось получить видео' } },
  en: { ph: 'Paste YouTube or TikTok links, one per line', find: 'Find', dl: 'Download',
    queued: 'Queued', processing: 'Processing…', saving: 'Saving…', done: 'Saved to gallery',
    video: 'MP4', audio: 'MP3 (audio)', history: 'History', empty: 'Nothing yet', server: 'Server address',
    notif: 'Download complete', e: { unsupported: 'Link not supported', private: 'This video is private',
    login_required: 'Sign-in required', age_restricted: 'Age-restricted video',
    geo_blocked: 'Not available in your region', unavailable: 'Video removed or unavailable',
    network: 'Cannot reach the server. Check the address in settings', unknown: 'Could not fetch the video' } },
};
const QUALS = [360, 720, 1080, 1440, 2160];
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

async function api(base, path, body) {
  let r;
  try {
    r = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  } catch { throw new Error('network'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || 'unknown');
  return r.json();
}

export default function App() {
  const sys = useColorScheme();
  const [dark, setDark] = useState(sys === 'dark');
  const [lang, setLang] = useState(getLocales()[0]?.languageCode === 'ru' ? 'ru' : 'en');
  const [server, setServer] = useState('https://video-app-me9k.onrender.com');
  const [input, setInput] = useState('');
  const [items, setItems] = useState([]); // queue cards
  const [hist, setHist] = useState([]);
  const t = T[lang];
  const c = dark ? { bg: '#0d1513', card: '#15201d', ink: '#e8f2ef', mute: '#8aa39b', line: '#25352f', acc: '#3ddbb8', accInk: '#06201a', err: '#ff7a6e' }
                 : { bg: '#f3f6f5', card: '#ffffff', ink: '#10201c', mute: '#5d716b', line: '#d9e3df', acc: '#0b8a73', accInk: '#ffffff', err: '#c8362b' };

  useEffect(() => {
    (async () => {
      const [s, h, l, th] = await Promise.all(['server', 'hist', 'lang', 'dark'].map((k) => AsyncStorage.getItem(k)));
      if (s) setServer(s); if (h) setHist(JSON.parse(h)); if (l) setLang(l); if (th) setDark(th === '1');
      await Notifications.requestPermissionsAsync();
      await MediaLibrary.requestPermissionsAsync(true);
    })();
  }, []);

  const patch = useCallback((id, p) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  async function addUrls() {
    const urls = [...new Set(input.split(/\s+/).filter(Boolean))];
    setInput('');
    for (const url of urls) {
      const id = Math.random().toString(36).slice(2);
      setItems((xs) => [{ id, url, loading: true, q: 1080, fmt: 'mp4' }, ...xs]);
      try {
        const info = await api(server, '/api/info', { url });
        const maxH = Math.max(0, ...info.heights);
        patch(id, { loading: false, info, maxH, q: [...QUALS].reverse().find((x) => x <= maxH) || 1080 });
      } catch (e) { patch(id, { loading: false, error: e.message }); }
    }
  }

  async function start(it) {
    patch(it.id, { status: 'queued', percent: 0, error: null });
    try {
      const { id: jid } = await api(server, '/api/jobs', { url: it.url, quality: it.q, format: it.fmt });
      let j;
      do { // poll progress
        await new Promise((r) => setTimeout(r, 700));
        j = await api(server, `/api/jobs/${jid}`);
        patch(it.id, { status: j.status, percent: j.percent, speed: j.speed, eta: j.eta });
      } while (j.status !== 'done' && j.status !== 'error');
      if (j.status === 'error') return patch(it.id, { status: 'error', error: j.error });

      patch(it.id, { status: 'saving' });
      const ext = it.fmt === 'mp3' ? 'mp3' : 'mp4';
      const dest = FileSystem.documentDirectory + `${jid}.${ext}`;
      await FileSystem.createDownloadResumable(`${server}/api/jobs/${jid}/file`, dest).downloadAsync();
      try { await MediaLibrary.saveToLibraryAsync(dest); } catch {}
      patch(it.id, { status: 'done', percent: 100 });

      const entry = { title: it.info.title, q: it.fmt === 'mp3' ? 'MP3' : `${it.q}p`, at: Date.now() };
      const next = [entry, ...hist].slice(0, 50);
      setHist(next); AsyncStorage.setItem('hist', JSON.stringify(next));
      Notifications.scheduleNotificationAsync({ content: { title: 'VidGrab', body: `${t.notif}: ${it.info.title}` }, trigger: null });
    } catch (e) { patch(it.id, { status: 'error', error: e.message }); }
  }

  const err = (k) => t.e[k] || t.e.unknown;
  const s = styles(c);

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: Platform.OS === 'android' ? 40 : 16 }} keyboardShouldPersistTaps="handled">
        <View style={s.head}>
          <Text style={s.h1}>VidGrab</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={s.tool} onPress={() => { const l = lang === 'ru' ? 'en' : 'ru'; setLang(l); AsyncStorage.setItem('lang', l); }}><Text style={s.ink}>{lang.toUpperCase()}</Text></TouchableOpacity>
            <TouchableOpacity style={s.tool} onPress={() => { setDark(!dark); AsyncStorage.setItem('dark', dark ? '0' : '1'); }}><Text style={s.ink}>{dark ? '☀' : '☾'}</Text></TouchableOpacity>
          </View>
        </View>

        <TextInput style={s.input} multiline placeholder={t.ph} placeholderTextColor={c.mute} value={input} onChangeText={setInput} autoCapitalize="none" autoCorrect={false} />
        <TouchableOpacity style={s.btn} onPress={addUrls}><Text style={s.btnTx}>{t.find}</Text></TouchableOpacity>

        {items.map((it) => (
          <View key={it.id} style={s.card}>
            {it.loading && <Text style={s.mute}>{it.url}…</Text>}
            {it.error && !it.info && <Text style={s.err}>{err(it.error)}</Text>}
            {it.info && (
              <>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <Image source={{ uri: it.info.thumbnail }} style={s.thumb} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.ink} numberOfLines={2}>{it.info.title}</Text>
                    <Text style={s.mute}>{it.info.author} · {fmtDur(it.info.duration)}</Text>
                  </View>
                </View>
                {it.fmt === 'mp4' && (
                  <View style={s.chips}>
                    {QUALS.map((q) => {
                      const off = it.maxH && q > it.maxH;
                      return <TouchableOpacity key={q} disabled={off} onPress={() => patch(it.id, { q })} style={[s.chip, it.q === q && s.chipOn, off && { opacity: 0.35 }]}><Text style={[s.chipTx, it.q === q && { color: c.accInk }]}>{q === 2160 ? '4K' : `${q}p`}</Text></TouchableOpacity>;
                    })}
                  </View>
                )}
                <View style={s.chips}>
                  {['mp4', 'mp3'].map((f) => (
                    <TouchableOpacity key={f} onPress={() => patch(it.id, { fmt: f })} style={[s.chip, it.fmt === f && s.chipOn]}><Text style={[s.chipTx, it.fmt === f && { color: c.accInk }]}>{f === 'mp4' ? t.video : t.audio}</Text></TouchableOpacity>
                  ))}
                </View>
                <TouchableOpacity style={[s.btn, it.status && it.status !== 'done' && it.status !== 'error' && { opacity: 0.5 }]} disabled={!!it.status && it.status !== 'done' && it.status !== 'error'} onPress={() => start(it)}><Text style={s.btnTx}>{t.dl}</Text></TouchableOpacity>
                {!!it.status && it.status !== 'error' && (
                  <>
                    <View style={s.bar}><View style={[s.fill, { width: `${it.percent || 0}%` }]} /></View>
                    <Text style={s.mute}>
                      {it.status === 'queued' ? t.queued : it.status === 'processing' ? t.processing : it.status === 'saving' ? t.saving : it.status === 'done' ? t.done
                        : `${it.percent || 0}%${it.speed ? ` · ${(it.speed / 1048576).toFixed(1)} MB/s` : ''}${it.eta ? ` · ${it.eta}s` : ''}`}
                    </Text>
                  </>
                )}
                {it.status === 'error' && <Text style={s.err}>{err(it.error)}</Text>}
              </>
            )}
          </View>
        ))}

        <Text style={[s.mute, { marginTop: 28, fontWeight: '600' }]}>{t.history}</Text>
        {hist.length === 0 && <Text style={s.mute}>{t.empty}</Text>}
        {hist.map((h, i) => (
          <View key={i} style={s.hist}><Text style={[s.ink, { flex: 1 }]} numberOfLines={1}>{h.title}</Text><Text style={s.mute}>{h.q}</Text></View>
        ))}

        <Text style={[s.mute, { marginTop: 28 }]}>{t.server}</Text>
        <TextInput style={[s.input, { minHeight: 0, padding: 12 }]} value={server} autoCapitalize="none" autoCorrect={false}
          onChangeText={(v) => { setServer(v); AsyncStorage.setItem('server', v); }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = (c) => StyleSheet.create({
  root: { flex: 1, backgroundColor: c.bg },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  h1: { fontSize: 24, fontWeight: '700', color: c.ink },
  tool: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  ink: { color: c.ink, fontSize: 15 }, mute: { color: c.mute, fontSize: 13, marginTop: 2 }, err: { color: c.err, fontSize: 14 },
  input: { minHeight: 110, textAlignVertical: 'top', padding: 16, fontSize: 16, color: c.ink, backgroundColor: c.card, borderWidth: 2, borderColor: c.line, borderRadius: 14, marginBottom: 10 },
  btn: { backgroundColor: c.acc, borderRadius: 10, paddingVertical: 13, alignItems: 'center', marginTop: 4 },
  btnTx: { color: c.accInk, fontWeight: '700', fontSize: 16 },
  card: { backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 14 },
  thumb: { width: 104, height: 78, borderRadius: 8, backgroundColor: c.line },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 8 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  chipOn: { backgroundColor: c.acc, borderColor: c.acc }, chipTx: { color: c.ink, fontSize: 14 },
  bar: { height: 8, backgroundColor: c.line, borderRadius: 4, overflow: 'hidden', marginTop: 10 },
  fill: { height: '100%', backgroundColor: c.acc },
  hist: { flexDirection: 'row', gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: c.line },
});
