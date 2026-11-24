import subprocess, os, math
from collections import deque

ART = os.environ.get("ART_DIR", ".")
SCRATCH = os.path.join(ART, "tmp_hd_build")
os.makedirs(SCRATCH, exist_ok=True)

def read_rgba(path):
    probe = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "csv=p=0", path
    ]).decode().strip()
    w, h = map(int, probe.split(","))
    raw = bytearray(subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"
    ]))
    return raw, w, h

def write_png(buf, w, h, path):
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{w}x{h}", "-i", "-", path
    ], input=bytes(buf), check=True)

def clear_white_bg(buf, w, h):
    """Border flood-fill pure white background + enclosed pure white gaps, preserving bright VFX."""
    visited = bytearray(w * h)
    q = deque()
    def is_bg(r, g, b):
        return r > 224 and g > 224 and b > 224 and (max(r, g, b) - min(r, g, b)) < 22

    for x in range(w):
        for y in (0, h - 1):
            idx = y * w + x
            if not visited[idx] and is_bg(buf[idx*4], buf[idx*4+1], buf[idx*4+2]):
                visited[idx] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            idx = y * w + x
            if not visited[idx] and is_bg(buf[idx*4], buf[idx*4+1], buf[idx*4+2]):
                visited[idx] = 1; q.append((x, y))

    while q:
        cx, cy = q.popleft()
        i = (cy * w + cx) * 4
        buf[i] = buf[i+1] = buf[i+2] = buf[i+3] = 0
        for nx, ny in ((cx+1, cy), (cx-1, cy), (cx, cy+1), (cx, cy-1)):
            if 0 <= nx < w and 0 <= ny < h:
                nidx = ny * w + nx
                if not visited[nidx]:
                    ni = nidx * 4
                    if is_bg(buf[ni], buf[ni+1], buf[ni+2]):
                        visited[nidx] = 1; q.append((nx, ny))

    # Clear enclosed pure-white neutral pockets (e.g. between legs/arms) while keeping hot cyan/orange VFX cores intact:
    # A pocket is truly background if it is pure white AND bordered mostly by dark outline pixels, not bright colored VFX.
    # First find connected components of remaining near-white pixels:
    wvis = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            i = idx * 4
            if buf[i+3] > 0 and not wvis[idx]:
                r, g, b = buf[i], buf[i+1], buf[i+2]
                if r > 235 and g > 235 and b > 235 and (max(r, g, b) - min(r, g, b)) < 14:
                    comp = []
                    cq = deque([(x, y)])
                    wvis[idx] = 1
                    dark_border = 0
                    color_border = 0
                    while cq:
                        px, py = cq.popleft()
                        comp.append((px, py))
                        for nx, ny in ((px+1, py), (px-1, py), (px, py+1), (px, py-1)):
                            if 0 <= nx < w and 0 <= ny < h:
                                nidx = ny * w + nx
                                ni = nidx * 4
                                if buf[ni+3] == 0:
                                    continue
                                nr, ng, nb = buf[ni], buf[ni+1], buf[ni+2]
                                if nr > 235 and ng > 235 and nb > 235 and (max(nr, ng, nb) - min(nr, ng, nb)) < 14:
                                    if not wvis[nidx]:
                                        wvis[nidx] = 1; cq.append((nx, ny))
                                else:
                                    if nr < 80 and ng < 80 and nb < 80:
                                        dark_border += 1
                                    elif (max(nr, ng, nb) - min(nr, ng, nb)) > 35:
                                        color_border += 1
                    if dark_border > color_border:
                        for px, py in comp:
                            pi = (py * w + px) * 4
                            buf[pi] = buf[pi+1] = buf[pi+2] = buf[pi+3] = 0

    # Soft defringe: fade 1px white-halo pixels touching transparency
    to_clear = []
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            if buf[i+3] > 0:
                r, g, b = buf[i], buf[i+1], buf[i+2]
                if r > 185 and g > 185 and b > 185 and (max(r, g, b) - min(r, g, b)) < 25:
                    for nx, ny in ((x+1, y), (x-1, y), (x, y+1), (x, y-1)):
                        if 0 <= nx < w and 0 <= ny < h and buf[(ny * w + nx) * 4 + 3] == 0:
                            to_clear.append(i)
                            break
    for i in to_clear:
        buf[i] = buf[i+1] = buf[i+2] = buf[i+3] = 0

def extract_frames(path, layout="1x4"):
    """Extract 4 cropped RGBA frames + body metrics from a 1x4 strip or 2x2 grid."""
    buf, w, h = read_rgba(path)
    clear_white_bg(buf, w, h)

    if layout == "2x2":
        # Split into 4 quadrants cleanly (top-left, top-right, bottom-left, bottom-right)
        mx, my = w // 2, h // 2
        boxes = [(0, 0, mx, my), (mx, 0, w, my), (0, my, mx, h), (mx, my, w, h)]
        out = []
        for x0, y0, x1, y1 in boxes:
            # Tight bbox inside quadrant
            xmin, xmax, ymin, ymax = x1, x0, y1, y0
            body_xmin, body_xmax, body_ymin, body_ymax = x1, x0, y1, y0
            for y in range(y0, y1):
                for x in range(x0, x1):
                    i = (y * w + x) * 4
                    if buf[i+3] > 0:
                        if x < xmin: xmin = x
                        if x > xmax: xmax = x
                        if y < ymin: ymin = y
                        if y > ymax: ymax = y
                        # Dark/armored body pixels (not pure VFX glow)
                        r, g, b = buf[i], buf[i+1], buf[i+2]
                        if r < 140 and g < 140 and b < 160:
                            if x < body_xmin: body_xmin = x
                            if x > body_xmax: body_xmax = x
                            if y < body_ymin: body_ymin = y
                            if y > body_ymax: body_ymax = y
            fw, fh = xmax - xmin + 1, ymax - ymin + 1
            crop = bytearray(fw * fh * 4)
            for y in range(fh):
                src_off = ((ymin + y) * w + xmin) * 4
                dst_off = (y * fw) * 4
                crop[dst_off:dst_off + fw*4] = buf[src_off:src_off + fw*4]
            out.append({
                "buf": crop, "w": fw, "h": fh,
                "body_cx": (body_xmin + body_xmax) * 0.5 - xmin,
                "body_h": body_ymax - body_ymin + 1,
                "foot_y": body_ymax - ymin
            })
        return out

    # 1x4 horizontal strip: use connected components to cleanly separate even slightly overlapping frames!
    comp_id = [-1] * (w * h)
    comps = []
    cid = 0
    for y in range(h):
        for x in range(w):
            idx = y * w + x
            if buf[idx*4 + 3] > 0 and comp_id[idx] == -1:
                q = deque([(x, y)])
                comp_id[idx] = cid
                cnt = 0; xmin = xmax = x; ymin = ymax = y; sx = 0
                while q:
                    cx, cy = q.popleft()
                    cnt += 1; sx += cx
                    if cx < xmin: xmin = cx
                    if cx > xmax: xmax = cx
                    if cy < ymin: ymin = cy
                    if cy > ymax: ymax = cy
                    for nx, ny in ((cx+1, cy), (cx-1, cy), (cx, cy+1), (cx, cy-1)):
                        if 0 <= nx < w and 0 <= ny < h:
                            nidx = ny * w + nx
                            if buf[nidx*4 + 3] > 0 and comp_id[nidx] == -1:
                                comp_id[nidx] = cid
                                q.append((nx, ny))
                comps.append((cid, cnt, xmin, xmax, ymin, ymax, sx / cnt))
                cid += 1

    main4 = sorted(comps, key=lambda c: -c[1])[:4]
    main4.sort(key=lambda c: c[6])
    main_ids = [c[0] for c in main4]

    comp_to_f = {}
    for c in comps:
        if c[1] < 25:
            continue
        if c[0] in main_ids:
            comp_to_f[c[0]] = main_ids.index(c[0])
        else:
            best_fi = min(range(4), key=lambda fi: abs(c[6] - main4[fi][6]))
            comp_to_f[c[0]] = best_fi

    out = []
    for fi in range(4):
        xmin, xmax, ymin, ymax = w, 0, h, 0
        bxmin, bxmax, bymin, bymax = w, 0, h, 0
        for c in comps:
            if comp_to_f.get(c[0]) == fi:
                xmin = min(xmin, c[2]); xmax = max(xmax, c[3])
                ymin = min(ymin, c[4]); ymax = max(ymax, c[5])
        fw, fh = xmax - xmin + 1, ymax - ymin + 1
        crop = bytearray(fw * fh * 4)
        for y in range(ymin, ymax + 1):
            for x in range(xmin, xmax + 1):
                idx = y * w + x
                if comp_id[idx] != -1 and comp_to_f.get(comp_id[idx]) == fi:
                    si = idx * 4
                    di = ((y - ymin) * fw + (x - xmin)) * 4
                    r, g, b, a = buf[si], buf[si+1], buf[si+2], buf[si+3]
                    crop[di] = r; crop[di+1] = g; crop[di+2] = b; crop[di+3] = a
                    if r < 140 and g < 140 and b < 160:
                        if x < bxmin: bxmin = x
                        if x > bxmax: bxmax = x
                        if y < bymin: bymin = y
                        if y > bymax: bymax = y
        out.append({
            "buf": crop, "w": fw, "h": fh,
            "body_cx": (bxmin + bxmax) * 0.5 - xmin,
            "body_h": bymax - bymin + 1,
            "foot_y": bymax - ymin
        })
    return out

def normalize_to_cell(frames, cell=256, ground_y=244, anchor_x=116, lift_indices=None):
    """Scale all frames uniformly per-sheet (or by median standing height) into crisp 256x256 RGBA cells."""
    lift_indices = lift_indices or {}
    # Target standing body height = ~156px inside 256x256 cell (leaves plenty of headroom for overhead claws, plasma pillars, & wide slashes!)
    target_body_h = 156.0
    cells = []
    for idx, f in enumerate(frames):
        # Compute scale from body_h, clamped so entire VFX+character fits cleanly inside 256x256
        s = target_body_h / max(1.0, f["body_h"])
        # Clamp scale if total sprite exceeds cell
        max_s_w = (cell - 8) / max(1.0, f["w"])
        max_s_h = (cell - 8) / max(1.0, f["h"])
        s = min(s, max_s_w, max_s_h)

        # Save cropped RGBA and scale cleanly with ffmpeg lanczos/neighbor? Wait: area/neighbor preserves crisp pixel art!
        # Since native frames are ~300-450px and target is ~180-250px, nearest-neighbor at non-integer ratio aliases slightly,
        # while lanczos + crisp alpha threshold keeps pixel edges razor-sharp!
        tmp_in = f"{SCRATCH}/tmp_in_{idx}.png"
        tmp_sc = f"{SCRATCH}/tmp_sc_{idx}.png"
        write_png(f["buf"], f["w"], f["h"], tmp_in)
        nw = max(1, int(round(f["w"] * s)))
        nh = max(1, int(round(f["h"] * s)))
        subprocess.run([
            "ffmpeg", "-y", "-v", "error", "-i", tmp_in,
            "-vf", f"scale={nw}:{nh}:flags=lanczos", tmp_sc
        ], check=True)
        sbuf, sw, sh = read_rgba(tmp_sc)

        # Hard-crisp alpha cutoff (removes semi-transparent halo while preserving clean edges)
        for i in range(0, len(sbuf), 4):
            if sbuf[i+3] < 110:
                sbuf[i] = sbuf[i+1] = sbuf[i+2] = sbuf[i+3] = 0
            else:
                sbuf[i+3] = 255

        # Place into 256x256 cell anchored at body_cx and foot_y
        bcx = int(round(f["body_cx"] * s))
        fy = int(round(f["foot_y"] * s))
        lift = lift_indices.get(idx, 0)
        ox = anchor_x - bcx
        oy = (ground_y - lift) - fy
        # Clamp inside cell bounds so nothing is ever clipped
        if ox < 2: ox = 2
        if ox + sw > cell - 2: ox = cell - 2 - sw
        if oy < 2: oy = 2
        if oy + sh > cell - 2: oy = cell - 2 - sh

        cbuf = bytearray(cell * cell * 4)
        for y in range(sh):
            dy = oy + y
            if 0 <= dy < cell:
                for x in range(sw):
                    dx = ox + x
                    if 0 <= dx < cell:
                        si = (y * sw + x) * 4
                        if sbuf[si+3] > 0:
                            di = (dy * cell + dx) * 4
                            cbuf[di:di+4] = sbuf[si:si+4]
        cells.append(cbuf)
    return cells

def make_bg(w, h, ground_y=None):
    buf = bytearray(w * h * 4)
    for y in range(h):
        # Subtle dark sci-fi navy gradient
        t = y / max(1, h - 1)
        br = int(10 + 10 * t)
        bg = int(16 + 14 * t)
        bb = int(28 + 20 * t)
        for x in range(w):
            # Subtle grid
            if (x % 32 == 0) or (y % 32 == 0):
                r, g, b = br + 7, bg + 10, bb + 14
            else:
                r, g, b = br, bg, bb
            if ground_y is not None and abs(y - ground_y) <= 1:
                r, g, b = 45, 78, 110
            i = (y * w + x) * 4
            buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255
    return buf

def blit_rgba(dst, dw, dh, src, sw, sh, ox, oy, flip_x=False):
    for y in range(sh):
        dy = oy + y
        if not (0 <= dy < dh): continue
        for x in range(sw):
            sx = (sw - 1 - x) if flip_x else x
            dx = ox + x
            if not (0 <= dx < dw): continue
            si = (y * sw + sx) * 4
            if src[si+3] > 0:
                di = (dy * dw + dx) * 4
                dst[di:di+4] = src[si:si+4]

def build_sheet_and_grid(cells, cols, rows, cell, sheet_path, grid_path):
    # Horizontal master transparent sheet
    n = len(cells)
    sw, sh = cell * n, cell
    sheet = bytearray(sw * sh * 4)
    for i, c in enumerate(cells):
        blit_rgba(sheet, sw, sh, c, cell, cell, i * cell, 0)
    write_png(sheet, sw, sh, sheet_path)

    # Grid contact sheet on dark grid bg
    gw, gh = cell * cols, cell * rows
    grid = make_bg(gw, gh)
    for i, c in enumerate(cells):
        col = i % cols
        row = i // cols
        blit_rgba(grid, gw, gh, c, cell, cell, col * cell, row * cell)
    write_png(grid, gw, gh, grid_path)

def render_gif(cells, seq, cell, fps, out_gif, pad=32):
    gw, gh = cell + pad * 2, cell + pad
    tmp = f"{SCRATCH}/gif_{os.path.basename(out_gif)}"
    os.makedirs(tmp, exist_ok=True)
    bg = make_bg(gw, gh, ground_y=pad // 2 + 244)
    for idx, fi in enumerate(seq):
        frame = bytearray(bg)
        blit_rgba(frame, gw, gh, cells[fi], cell, cell, pad, pad // 2)
        write_png(frame, gw, gh, f"{tmp}/f_{idx:03d}.png")
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-framerate", str(fps),
        "-i", f"{tmp}/f_%03d.png",
        "-vf", "split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
        "-loop", "0", out_gif
    ], check=True)

# === 1. KAIJU 12-FRAME HD COMBO ===
print("Extracting Kaiju Phase 1, 2, 3...")
k1 = extract_frames(f"{ART}/kaiju_phase1_roar_spritesheet_v2_1795329952921.jpg", "1x4")
k2 = extract_frames(f"{ART}/kaiju_phase2_combo_sheet_v3_1795329980657.jpg", "1x4")
k3 = extract_frames(f"{ART}/kaiju_phase3_slam_sheet_1795329931098.jpg", "1x4")
kaiju_raw = k1 + k2 + k3
# Frame 8 (index 8 = Phase 3 Frame 1) is jumping overhead wind-up -> lift 22px!
kaiju_cells = normalize_to_cell(kaiju_raw, cell=256, ground_y=244, anchor_x=114, lift_indices={8: 22})
build_sheet_and_grid(
    kaiju_cells, 4, 3, 256,
    f"{ART}/kaiju_hd_12frame_sheet_3072x256.png",
    f"{ART}/kaiju_hd_12frame_grid.png"
)
# Pacing sequence for Kaiju 12-frame combo (holds on key impact & roar frames for punchy arcade feel!)
k_seq = [0, 0, 1, 1, 2, 2, 3, 4, 5, 5, 6, 7, 8, 9, 9, 9, 10, 10, 11, 11]
render_gif(kaiju_cells, k_seq, 256, fps=10, out_gif=f"{ART}/kaiju_hd_combo.gif")
print("Kaiju HD 12-frame done!")

# === 2. JAEGER 8-FRAME HD COMBO ===
print("Extracting Jaeger Phase 1, 2...")
j1 = extract_frames(f"{ART}/jaeger_phase1_spritesheet_1795329952028.jpg", "1x4")
j2 = extract_frames(f"{ART}/jaeger_phase2_rocket_punch_plasma_sword_sheet_1795329953304.jpg", "2x2")
jaeger_raw = j1 + j2
jaeger_cells = normalize_to_cell(jaeger_raw, cell=256, ground_y=244, anchor_x=114)
build_sheet_and_grid(
    jaeger_cells, 4, 2, 256,
    f"{ART}/jaeger_hd_8frame_sheet_2048x256.png",
    f"{ART}/jaeger_hd_8frame_grid.png"
)
j_seq = [0, 0, 1, 1, 2, 2, 3, 4, 4, 4, 5, 5, 6, 6, 6, 7, 7, 0]
render_gif(jaeger_cells, j_seq, 256, fps=10, out_gif=f"{ART}/jaeger_hd_combo.gif")
print("Jaeger HD 8-frame done!")

# === 3. BONUS: HD BOSS FIGHT DUEL GIF (Jaeger vs Kaiju trading full combos + screen shake!) ===
print("Rendering Jaeger vs Kaiju HD Duel GIF...")
dw, dh = 560, 300
duel_tmp = f"{SCRATCH}/gif_duel"
os.makedirs(duel_tmp, exist_ok=True)
duel_bg = make_bg(dw, dh, ground_y=270)
# Choreograph 24-beat boss duel: (jaeger_f, kaiju_f, j_dx, k_dx, shake_y)
duel_script = [
    (0, 0,   0,   0, 0),
    (0, 1,   0,   0, 0),
    (1, 2,   0,   0, 2),   # Jaeger overdrive + Kaiju plasma roar!
    (1, 2,   0,   0, -2),
    (2, 3,  -4,   4, 0),   # Rocket ignition vs Kaiju lunge prep
    (3, 4,   4,  -6, 0),
    (4, 5,  24, -18, 5),   # CLASH! Rocket Punch vs Giant Cyan Crescent Slash!
    (4, 5,  22, -16, -4),
    (4, 6,  14, -12, 2),   # Kaiju rising uppercut!
    (5, 7,   2,  -4, 0),   # Jaeger deploys Dual Chain Swords vs Kaiju twin-claw apex
    (5, 8,   4,  -2, 0),   # Kaiju leaps for ground slam!
    (6, 9,  20, -14, 6),   # MEGA CLASH! Fiery Plasma Sword Slash vs Cyan Plasma Pillar Slam!
    (6, 9,  18, -12, -5),
    (6, 9,  16, -12, 3),
    (7, 10, 10,  -6, 0),   # Follow-through & smoking mist
    (7, 10,  6,  -4, 0),
    (0, 11,  0,   0, 0),   # Both recover to battle stance
    (0, 11,  0,   0, 0),
]
for idx, (jf, kf, jdx, kdx, sh) in enumerate(duel_script):
    frame = bytearray(duel_bg)
    # Jaeger on left facing right, Kaiju on right flipped facing left!
    blit_rgba(frame, dw, dh, jaeger_cells[jf], 256, 256, 32 + jdx, 26 + sh, flip_x=False)
    blit_rgba(frame, dw, dh, kaiju_cells[kf],  256, 256, 272 + kdx, 26 + sh, flip_x=True)
    write_png(frame, dw, dh, f"{duel_tmp}/f_{idx:03d}.png")

subprocess.run([
    "ffmpeg", "-y", "-v", "error", "-framerate", "9",
    "-i", f"{duel_tmp}/f_%03d.png",
    "-vf", "split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3",
    "-loop", "0", f"{ART}/jaeger_vs_kaiju_duel_hd.gif"
], check=True)
print("ALL HD ASSETS BUILT SUCCESSFULLY!")
