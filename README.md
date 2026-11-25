# Lucky Wheel 🎡: site lal haz (raffle)

## Kif byemshe
**Lal nas (bala account):**
1. Byfoto 3al site, byshufo kel l prizes (dawalib), w byekbso 3a wa7ad.
2. Byna2o l ar2am bel table, w bya3mlo **OK**.
3. Btetla3 pop-up: l esem, ra2m l cell, w khene "I sent $X by Whish". Bya3mlo **OK**.
4. L ar2am btsir **7amra** (ma7jouze) dighre. **Li byesba2, byekhod l ra2em.**
5. Bs l admin ya3mel **Approve**, l ar2am btsir la2elo, w byenba3atlo WhatsApp "shukran, ar2amak kaza w kaza".

**Lal admin** (`#/admin`, aw link "Admin" ta7t l safha):
- **+ Add wheel**: kel douleb 3ando l prize, kam ra2em (1–100), l se3r, **ra2m Whish khas fi**, w date l haz.
- **Requests to approve**: kel talab jdid byzhar dighre. Fi **Reject** (l ar2am byerja3o fadyin), w **Approve + WhatsApp**: byakked l ar2am w byefta7 WhatsApp ma3 risalet "shukran" jehze.
- **Add numbers yourself**: btekbos ar2am fadye, btekteb esem (w ra2m iza baddak), w bta3mel Add. La l nas li bya3touk l masari bel ide.
  Iza kabast 3a ra2em a7mar, btshuf min ma3o, w fik tmahi.
- **Tell everyone the draw time**: bs yenba3o kel l ar2am w t7ott l date, fi zarr WhatsApp la kel wa7ad ma3 ar2amo.
- **WhatsApp messages**: fik t3adel nass l risale (shukran, w maw3ed l haz).
- **Douleb l haz**: countdown, ba3den zarr **START** bas lal admin. Kel l nas byshufo l douleb live: ~10 seconds sari3, ba3den bykhaffef w by2af, w pop-up "CONGRATULATIONS" ma3 confetti.

**L WhatsApp:** l risale btenba3at men l WhatsApp li 3al telephone (aw l computer) li 3am tekbos menno. Ya3ne men ra2mak.
L site byefta7lak l risale jehze, w enta bta3mel Send. Ma fi ba3et automatic bala service medfou3a.

**Byemshe 3a kel l devices** w byen3amalo install (Android: zarr Install; iPhone: Share ← Add to Home Screen).

---

## Jarrbo 3a computerak
Bel folder `raffle`, bel terminal:
```
npx.cmd serve .
```
Ba3den eftah `http://localhost:3000`.
- **Ctrl + C bel terminal bitwa22ef l server.** La tenskh: Ctrl + Shift + C.
- Bel demo, l data bteb2a 3a hayda l browser bas.
- Admin bel demo: ruh 3a `#/admin`, email **admin@demo.com**, w ay password (6+ a7ruf) awwal marra.
- Bel Manage taba3 kel douleb fi "Fill remaining numbers (demo test)" la tjarreb l douleb.

## Kif tetla3o live (b Supabase)
1. Bel Supabase project taba3ak: **SQL Editor → New query**. Eftah `supabase.sql`, ghayyer `admin@demo.com` la email l admin taba3ak, l2ot kel l file w a3mel **Run**.
   Hayda byesna3 l tables (wheels, numbers, requests), l 7imeye (RLS), w l functions.
2. **Authentication → Sign In / Providers**:
   - **Email**: khalli enabled (lal admin).
   - **Allow anonymous sign-ins**: **ON** (lal zuwwar, la ma ya3mlo account).
3. **Authentication → Users → Add user → Create new user**: 7ott email w password l admin (w 3allem *Auto Confirm User*).
4. **Project Settings → API** (aw zarr **Connect**): enskh l **Project URL** w l **anon / publishable key**.
   7otton bel `config.js`, w 7ott email l admin bel `ADMIN_EMAILS`.
   *(Ma t7ott abadan l `service_role` key bel site.)*
5. **Hosting**: ishhab l folder 3a https://app.netlify.com/drop (as-hal shi), aw Vercel, aw ay hosting static.
6. Eftah `https://SITE-TABA3AK/#/admin`, fut, w a3mel **+ Add wheel**. B3at l link lal nas. 🎉

Iza ghayyart l email l admin ba3den: ghayyro bel `config.js` w **kamen** bel function `is_admin` (SQL Editor, ghayyer l email w Run marra tenye).

## Mlahazat
- Whish ma 3ando API, fa l site ma fi y2akkid l daf3 la7alo. Enta bt2akked (Approve) ba3d ma tshuf l masari 3a Whish.
- Iza 7ada 7ajaz ar2am w ma dafa3, a3mel **Reject** w byerja3o fadyin.
- Ra2m l telephone bas l admin byshufo (w l shakhes nafso). Bel douleb byzhar l esem bas.
- Round jdid: Manage ← "Start new round". "Delete wheel" bimahe l douleb kello.

## Files
| File | Shu huwe |
|---|---|
| `index.html`, `styles.css`, `app.js` | L site |
| `backend.js` | Supabase aw demo |
| `config.js` | Supabase URL + key, w email l admin |
| `supabase.sql` | L tables, l 7imeye (RLS) w l functions: btel2oto bel SQL Editor |
| `manifest.webmanifest`, `sw.js`, `icons/` | La yen3amal install ka app |
