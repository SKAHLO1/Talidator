"use client";

import { onAuthStateChanged, signInWithCustomToken, signOut as fbSignOut } from "firebase/auth";
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createSiweMessage } from "viem/siwe";
import { useConnection } from "wagmi";
import { getConnection, signMessage, switchChain } from "wagmi/actions";
import { CHAIN_ID, wagmiConfig } from "../chain/config";
import { firebase, firebaseEnabled } from "../firebase/client";
import { useStore } from "../store";
import { DEFAULT_ALERTS, SIWE_STATEMENT, type AgentNote, type Profile, type WatchItem } from "./model";
import { createNotesKey, open, passkeySupported, seal, unlockNotesKey } from "./vault";

export type AccountStatus = "disabled" | "loading" | "signed-out" | "signing-in" | "signed-in";

interface AccountCtx {
  status: AccountStatus;
  /** lowercase wallet address of the signed-in user */
  uid: string | null;
  profile: Profile | null;
  watchlist: WatchItem[];
  notes: Record<string, AgentNote>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  updateProfile: (patch: Partial<Pick<Profile, "displayName" | "avatarUrl" | "alerts">>) => Promise<void>;
  markAlertsSeen: () => Promise<void>;
  isWatched: (ref: string) => boolean;
  toggleWatch: (kind: WatchItem["kind"], ref: string, label: string) => Promise<void>;
  setNote: (agent: string, label: string, note: string) => Promise<void>;
  /** Passkey (Mera PRF) encryption for private notes */
  vault: {
    status: "unsupported" | "none" | "locked" | "unlocked";
    busy: boolean;
    enable: () => Promise<void>;
    unlock: () => Promise<void>;
    lock: () => void;
  };
}

const Ctx = createContext<AccountCtx | null>(null);

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const { dispatch } = useStore();
  const conn = useConnection();
  const [status, setStatus] = useState<AccountStatus>(firebaseEnabled ? "loading" : "disabled");
  const [uid, setUid] = useState<string | null>(null);
  // Snapshot data is tagged with the uid it was read for, so a sign-out/switch never shows stale data.
  const [profileData, setProfile] = useState<{ uid: string; value: Profile | null } | null>(null);
  const [watchData, setWatchlist] = useState<{ uid: string; value: WatchItem[] } | null>(null);
  const [notesData, setNotes] = useState<{ uid: string; value: Record<string, AgentNote> } | null>(null);
  const profile = profileData && profileData.uid === uid ? profileData.value : null;
  const watchlist = useMemo(() => (watchData && watchData.uid === uid ? watchData.value : []), [watchData, uid]);
  const rawNotes = useMemo(() => (notesData && notesData.uid === uid ? notesData.value : {}), [notesData, uid]);
  const signingIn = useRef(false);

  // Notes key: an in-memory, non-extractable AES key derived from the user's passkey. Never persisted.
  const [keyData, setKeyData] = useState<{ uid: string; key: CryptoKey } | null>(null);
  const vaultKey = keyData && keyData.uid === uid ? keyData.key : null;
  const [vaultBusy, setVaultBusy] = useState(false);
  const [decrypted, setDecrypted] = useState<{ key: CryptoKey; bodies: Record<string, string> } | null>(null);

  useEffect(() => {
    if (!vaultKey) return;
    let live = true;
    Promise.all(
      Object.entries(rawNotes)
        .filter(([, n]) => n.enc)
        .map(async ([id, n]) => [id, await open(vaultKey, n.enc!).catch(() => "⚠ could not decrypt")] as const),
    ).then((pairs) => live && setDecrypted({ key: vaultKey, bodies: Object.fromEntries(pairs) }));
    return () => {
      live = false;
    };
  }, [vaultKey, rawNotes]);

  const notes = useMemo(() => {
    const bodies = decrypted && decrypted.key === vaultKey ? decrypted.bodies : {};
    return Object.fromEntries(
      Object.entries(rawNotes).map(([id, n]) =>
        [id, n.enc ? (id in bodies ? { ...n, note: bodies[id]! } : { ...n, note: "", locked: true }) : n]),
    ) as Record<string, AgentNote>;
  }, [rawNotes, decrypted, vaultKey]);

  const toast = useCallback(
    (tone: "success" | "danger" | "info", title: string, detail?: string) => dispatch({ type: "TOAST", tone, title, detail }),
    [dispatch],
  );

  // Firebase session.
  useEffect(() => {
    if (!firebaseEnabled) return;
    return onAuthStateChanged(firebase().auth, (user) => {
      setUid(user?.uid ?? null);
      if (!signingIn.current) setStatus(user ? "signed-in" : "signed-out");
    });
  }, []);

  // Live per-user documents.
  useEffect(() => {
    if (!uid) return;
    const { db } = firebase();
    const unsubs = [
      onSnapshot(doc(db, "users", uid), (s) => {
        const d = s.data() as Profile | undefined;
        setProfile({ uid, value: d ? { ...d, alerts: { ...DEFAULT_ALERTS, ...d.alerts } } : null });
      }),
      onSnapshot(collection(db, "users", uid, "watchlist"), (s) =>
        setWatchlist({ uid, value: s.docs.map((d) => d.data() as WatchItem) })),
      onSnapshot(collection(db, "users", uid, "notes"), (s) =>
        setNotes({ uid, value: Object.fromEntries(s.docs.map((d) => [d.id, d.data() as AgentNote])) })),
    ];
    return () => unsubs.forEach((u) => u());
  }, [uid]);

  // A session belongs to one wallet: if the wallet switches to another address, sign out.
  useEffect(() => {
    if (!uid || !conn.address || conn.address.toLowerCase() === uid) return;
    fbSignOut(firebase().auth);
    toast("info", "Signed out", "Your wallet switched to a different address — sign in again for its dashboard.");
  }, [uid, conn.address, toast]);

  const signIn = useCallback(async () => {
    if (!firebaseEnabled) return;
    signingIn.current = true;
    setStatus("signing-in");
    try {
      const c = getConnection(wagmiConfig);
      if (!c.isConnected || !c.address) throw new Error("Connect a wallet first");
      if (c.chainId !== CHAIN_ID) await switchChain(wagmiConfig, { chainId: CHAIN_ID });
      const { nonce } = await postJson<{ nonce: string }>("/api/auth/nonce");
      const message = createSiweMessage({
        domain: window.location.host,
        address: c.address,
        statement: SIWE_STATEMENT,
        uri: window.location.origin,
        version: "1",
        chainId: CHAIN_ID,
        nonce,
      });
      const signature = await signMessage(wagmiConfig, { message });
      const { token } = await postJson<{ token: string }>("/api/auth/verify", { message, signature });
      await signInWithCustomToken(firebase().auth, token);
      setStatus("signed-in");
      toast("success", "Signed in", "Your dashboard is now personalised to this wallet.");
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      setStatus(firebase().auth.currentUser ? "signed-in" : "signed-out");
      toast("danger", "Sign-in failed", /rejected|denied/i.test(msg) ? "Signature request was rejected." : msg);
    } finally {
      signingIn.current = false;
    }
  }, [toast]);

  const signOut = useCallback(async () => {
    if (firebaseEnabled) await fbSignOut(firebase().auth);
  }, []);

  const guard = useCallback(
    async (label: string, fn: (db: ReturnType<typeof firebase>["db"], uid: string) => Promise<unknown>) => {
      if (!uid) return toast("info", "Sign in first", "Personal dashboards need a wallet sign-in.");
      try {
        await fn(firebase().db, uid);
      } catch (e) {
        toast("danger", label, (e as Error).message);
      }
    },
    [uid, toast],
  );

  const enableVault = useCallback(async () => {
    if (!uid) return;
    setVaultBusy(true);
    try {
      const { key, info } = await createNotesKey(uid, profile?.displayName || uid);
      const { db } = firebase();
      await updateDoc(doc(db, "users", uid), { notesKey: info });
      // Migrate existing plaintext notes into ciphertext.
      for (const [id, n] of Object.entries(rawNotes)) {
        if (n.enc || !n.note) continue;
        await setDoc(doc(db, "users", uid, "notes", id), { label: n.label, note: "", enc: await seal(key, n.note), updatedAt: serverTimestamp() });
      }
      setKeyData({ uid, key });
      toast("success", "Notes encrypted", "Your private notes are now encrypted with a key derived from your passkey.");
    } catch (e) {
      toast("danger", "Could not set up passkey encryption", (e as Error).message.split("\n")[0]);
    } finally {
      setVaultBusy(false);
    }
  }, [uid, profile, rawNotes, toast]);

  const unlockVault = useCallback(async () => {
    if (!uid || !profile?.notesKey) return;
    setVaultBusy(true);
    try {
      setKeyData({ uid, key: await unlockNotesKey(profile.notesKey) });
    } catch (e) {
      toast("danger", "Could not unlock notes", (e as Error).message.split("\n")[0]);
    } finally {
      setVaultBusy(false);
    }
  }, [uid, profile, toast]);

  const value = useMemo<AccountCtx>(() => {
    const watched = new Set(watchlist.map((w) => w.ref));
    const vaultStatus: AccountCtx["vault"]["status"] = !passkeySupported()
      ? "unsupported"
      : !profile?.notesKey ? "none" : vaultKey ? "unlocked" : "locked";
    return {
      status, uid, profile, watchlist, notes, signIn, signOut,
      vault: { status: vaultStatus, busy: vaultBusy, enable: enableVault, unlock: unlockVault, lock: () => setKeyData(null) },
      updateProfile: (patch) => guard("Could not save profile", (db, u) => updateDoc(doc(db, "users", u), patch)),
      markAlertsSeen: () => guard("Could not update alerts", (db, u) =>
        updateDoc(doc(db, "users", u), { alertsSeenAt: Math.floor(Date.now() / 1000) })),
      isWatched: (ref) => watched.has(ref.toLowerCase()),
      toggleWatch: (kind, ref, label) => guard("Could not update watchlist", (db, u) => {
        const id = ref.toLowerCase();
        const target = doc(db, "users", u, "watchlist", id);
        return watched.has(id) ? deleteDoc(target) : setDoc(target, { kind, ref: id, label: label.slice(0, 120), addedAt: serverTimestamp() });
      }),
      setNote: (agent, label, note) => guard("Could not save note", async (db, u) => {
        const target = doc(db, "users", u, "notes", agent.toLowerCase());
        const body = note.trim().slice(0, 1000);
        if (!label.trim() && !body) return deleteDoc(target);
        const data: Record<string, unknown> = { label: label.trim().slice(0, 40), note: body, updatedAt: serverTimestamp() };
        if (profile?.notesKey) {
          // Encrypted account: never write a plaintext body.
          if (!vaultKey) throw new Error("Unlock your notes with your passkey first.");
          data.note = "";
          if (body) data.enc = await seal(vaultKey, body);
        }
        return setDoc(target, data);
      }),
    };
  }, [status, uid, profile, watchlist, notes, signIn, signOut, guard, vaultKey, vaultBusy, enableVault, unlockVault]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAccount() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAccount must be used inside <AccountProvider>");
  return v;
}
