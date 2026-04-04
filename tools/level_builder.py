"""
Zelda Online — Level Builder
Tkinter-based tool for designing levels.
Outputs JSON that the game loads at runtime.

Controls:
  Left-click + drag on terrain  → raise terrain
  Right-click + drag on terrain → lower terrain
  Mouse wheel                   → adjust brush size
  Tool buttons in sidebar       → select placement mode
  Click on map in placement mode→ place object
  Delete key with selection     → remove selected object
  Ctrl+S                        → save
  Ctrl+Z                        → undo terrain stroke
"""

import json
import math
import os
import sys
import tkinter as tk
from tkinter import ttk, filedialog, messagebox
from typing import Optional

# ── Constants matching the game ──────────────────────────────────────────────
GROUND_SIZE = 200
SUBDIVISIONS = 128
GRID = SUBDIVISIONS + 1  # 129 vertices per axis
WATER_Y = -0.4
CELL_WORLD = GROUND_SIZE / SUBDIVISIONS  # ~1.5625 world units per cell

# Canvas sizing
CANVAS_SIZE = 650
CELL_PX = CANVAS_SIZE / GRID  # pixels per cell

# ── Default noise (matches game's hillNoise) ────────────────────────────────
def _hash(ix: int, iz: int) -> float:
    n = math.sin(ix * 127.1 + iz * 311.7) * 43758.5453
    return n - math.floor(n)

def _smooth(x: float, z: float) -> float:
    ix, iz = int(math.floor(x)), int(math.floor(z))
    fx, fz = x - ix, z - iz
    sx = fx * fx * (3 - 2 * fx)
    sz = fz * fz * (3 - 2 * fz)
    a, b = _hash(ix, iz), _hash(ix + 1, iz)
    c, d = _hash(ix, iz + 1), _hash(ix + 1, iz + 1)
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz

def hill_noise(wx: float, wz: float) -> float:
    h = 0.0
    h += _smooth(wx * 0.02, wz * 0.02) * 6
    h += _smooth(wx * 0.06, wz * 0.06) * 2
    h += _smooth(wx * 0.15, wz * 0.15) * 0.5
    return h - 3


def world_from_grid(gx: int, gz: int) -> tuple[float, float]:
    """Grid index → world coordinate (centered at 0)."""
    return (gx * CELL_WORLD - GROUND_SIZE / 2,
            gz * CELL_WORLD - GROUND_SIZE / 2)


def grid_from_world(wx: float, wz: float) -> tuple[int, int]:
    """World coordinate → nearest grid index."""
    gx = round((wx + GROUND_SIZE / 2) / CELL_WORLD)
    gz = round((wz + GROUND_SIZE / 2) / CELL_WORLD)
    return max(0, min(GRID - 1, gx)), max(0, min(GRID - 1, gz))


# ── Elevation → colour ──────────────────────────────────────────────────────
def height_color(h: float) -> str:
    """Map height to a colour string: deep blue → green → brown → white."""
    if h < WATER_Y:
        t = max(0.0, min(1.0, (h - (-4)) / (WATER_Y - (-4))))
        r = int(10 + 30 * t)
        g = int(30 + 80 * t)
        b = int(120 + 80 * t)
    elif h < 1.5:
        t = (h - WATER_Y) / (1.5 - WATER_Y)
        r = int(50 + 40 * t)
        g = int(140 - 30 * t)
        b = int(40 - 20 * t)
    elif h < 4.0:
        t = (h - 1.5) / 2.5
        r = int(90 + 80 * t)
        g = int(110 - 50 * t)
        b = int(20 + 10 * t)
    else:
        t = min(1.0, (h - 4.0) / 3.0)
        r = int(170 + 85 * t)
        g = int(60 + 195 * t)
        b = int(30 + 225 * t)
    return f"#{r:02x}{g:02x}{b:02x}"


# ── Object icons (for drawing on canvas) ────────────────────────────────────
OBJECT_TYPES = {
    "player_spawn": {"label": "Player Spawn", "color": "#00ff00", "shape": "star", "unique": True},
    "enemy_orc":    {"label": "Orc Spawn",    "color": "#ff4444", "shape": "circle"},
    "enemy_goblin": {"label": "Goblin Spawn", "color": "#ff8800", "shape": "circle"},
    "cabin":        {"label": "Cabin",         "color": "#8B4513", "shape": "rect"},
    "tower":        {"label": "Tower",         "color": "#A0522D", "shape": "diamond"},
    "campfire":     {"label": "Campfire",      "color": "#ff6600", "shape": "triangle"},
}


class LevelBuilder(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Zelda Online — Level Builder")
        self.configure(bg="#2b2b2b")
        self.resizable(True, True)

        # State
        self.heightmap: list[list[float]] = [[0.0] * GRID for _ in range(GRID)]
        self.objects: list[dict] = []  # {type, wx, wz, rotation?}
        self.roads: list[list[tuple[float, float]]] = []  # list of polylines in world coords
        self.current_road: list[tuple[float, float]] = []
        self.selected_idx: Optional[int] = None
        self.tool = "terrain_raise"  # current tool
        self.brush_radius = 3  # grid cells
        self.brush_strength = 0.4
        self.undo_stack: list[list[list[float]]] = []  # terrain snapshots
        self._painting = False
        self._current_stroke_saved = False
        self.file_path: Optional[str] = None

        self._build_ui()
        self._generate_default_terrain()
        self._redraw_terrain()

    # ── UI Construction ──────────────────────────────────────────────────────
    def _build_ui(self):
        # Menu bar
        menubar = tk.Menu(self, bg="#3c3c3c", fg="white")
        filemenu = tk.Menu(menubar, tearoff=0, bg="#3c3c3c", fg="white")
        filemenu.add_command(label="New", command=self._new_level, accelerator="Ctrl+N")
        filemenu.add_command(label="Open…", command=self._open_file, accelerator="Ctrl+O")
        filemenu.add_command(label="Save", command=self._save, accelerator="Ctrl+S")
        filemenu.add_command(label="Save As…", command=self._save_as)
        filemenu.add_separator()
        filemenu.add_command(label="Generate Default Terrain", command=self._generate_default_terrain_and_redraw)
        filemenu.add_command(label="Flatten All", command=self._flatten_all)
        menubar.add_cascade(label="File", menu=filemenu)

        editmenu = tk.Menu(menubar, tearoff=0, bg="#3c3c3c", fg="white")
        editmenu.add_command(label="Undo Terrain", command=self._undo_terrain, accelerator="Ctrl+Z")
        menubar.add_cascade(label="Edit", menu=editmenu)
        self.config(menu=menubar)

        # Keyboard shortcuts
        self.bind_all("<Control-s>", lambda e: self._save())
        self.bind_all("<Control-z>", lambda e: self._undo_terrain())
        self.bind_all("<Control-n>", lambda e: self._new_level())
        self.bind_all("<Control-o>", lambda e: self._open_file())
        self.bind_all("<Delete>", lambda e: self._delete_selected())

        # Main layout: sidebar | canvas
        main = tk.Frame(self, bg="#2b2b2b")
        main.pack(fill="both", expand=True)

        # ── Sidebar ──────────────────────────────────────────────────────────
        sidebar = tk.Frame(main, bg="#333", width=220, relief="sunken", bd=1)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)

        tk.Label(sidebar, text="TOOLS", bg="#333", fg="#ccc",
                 font=("Segoe UI", 11, "bold")).pack(pady=(10, 5))

        # Tool buttons
        self._tool_buttons: dict[str, tk.Button] = {}
        tool_frame = tk.Frame(sidebar, bg="#333")
        tool_frame.pack(fill="x", padx=8)

        terrain_tools = [
            ("terrain_raise", "🔼 Raise Terrain"),
            ("terrain_lower", "🔽 Lower Terrain"),
            ("terrain_smooth", "〰️ Smooth"),
        ]
        for tid, label in terrain_tools:
            btn = tk.Button(tool_frame, text=label, bg="#444", fg="white",
                            activebackground="#555", relief="flat", anchor="w",
                            padx=8, pady=4, font=("Segoe UI", 9),
                            command=lambda t=tid: self._set_tool(t))
            btn.pack(fill="x", pady=1)
            self._tool_buttons[tid] = btn

        ttk.Separator(sidebar, orient="horizontal").pack(fill="x", padx=8, pady=6)
        tk.Label(sidebar, text="PLACE OBJECTS", bg="#333", fg="#ccc",
                 font=("Segoe UI", 10, "bold")).pack(pady=(2, 4))

        obj_frame = tk.Frame(sidebar, bg="#333")
        obj_frame.pack(fill="x", padx=8)

        for otype, info in OBJECT_TYPES.items():
            btn = tk.Button(obj_frame, text=info["label"], bg="#444", fg=info["color"],
                            activebackground="#555", relief="flat", anchor="w",
                            padx=8, pady=4, font=("Segoe UI", 9),
                            command=lambda t=otype: self._set_tool(t))
            btn.pack(fill="x", pady=1)
            self._tool_buttons[otype] = btn

        ttk.Separator(sidebar, orient="horizontal").pack(fill="x", padx=8, pady=6)

        road_btn = tk.Button(obj_frame, text="🛤️ Draw Road", bg="#444", fg="#dda520",
                             activebackground="#555", relief="flat", anchor="w",
                             padx=8, pady=4, font=("Segoe UI", 9),
                             command=lambda: self._set_tool("road"))
        road_btn.pack(fill="x", pady=1)
        self._tool_buttons["road"] = road_btn

        ttk.Separator(sidebar, orient="horizontal").pack(fill="x", padx=8, pady=6)

        # Brush settings
        tk.Label(sidebar, text="BRUSH", bg="#333", fg="#ccc",
                 font=("Segoe UI", 10, "bold")).pack(pady=(2, 4))

        brush_frame = tk.Frame(sidebar, bg="#333")
        brush_frame.pack(fill="x", padx=12)

        tk.Label(brush_frame, text="Radius:", bg="#333", fg="#aaa",
                 font=("Segoe UI", 9)).grid(row=0, column=0, sticky="w")
        self._radius_var = tk.IntVar(value=self.brush_radius)
        self._radius_slider = tk.Scale(brush_frame, from_=1, to=15,
                                       orient="horizontal", variable=self._radius_var,
                                       bg="#333", fg="white", troughcolor="#555",
                                       highlightthickness=0, length=120,
                                       command=lambda v: setattr(self, 'brush_radius', int(v)))
        self._radius_slider.grid(row=0, column=1, sticky="ew")

        tk.Label(brush_frame, text="Strength:", bg="#333", fg="#aaa",
                 font=("Segoe UI", 9)).grid(row=1, column=0, sticky="w")
        self._strength_var = tk.DoubleVar(value=self.brush_strength)
        self._strength_slider = tk.Scale(brush_frame, from_=0.05, to=2.0,
                                         orient="horizontal", variable=self._strength_var,
                                         resolution=0.05, bg="#333", fg="white",
                                         troughcolor="#555", highlightthickness=0,
                                         length=120,
                                         command=lambda v: setattr(self, 'brush_strength', float(v)))
        self._strength_slider.grid(row=1, column=1, sticky="ew")
        brush_frame.columnconfigure(1, weight=1)

        ttk.Separator(sidebar, orient="horizontal").pack(fill="x", padx=8, pady=6)

        # Info display
        self._info_var = tk.StringVar(value="Ready")
        tk.Label(sidebar, textvariable=self._info_var, bg="#333", fg="#8cf",
                 font=("Segoe UI", 9), wraplength=200, justify="left").pack(
            padx=8, pady=4, anchor="w")

        # Object list
        tk.Label(sidebar, text="OBJECTS", bg="#333", fg="#ccc",
                 font=("Segoe UI", 10, "bold")).pack(pady=(6, 2))
        list_frame = tk.Frame(sidebar, bg="#333")
        list_frame.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self._obj_listbox = tk.Listbox(list_frame, bg="#222", fg="white",
                                       selectbackground="#446", font=("Consolas", 9),
                                       highlightthickness=0, bd=0)
        self._obj_listbox.pack(fill="both", expand=True)
        self._obj_listbox.bind("<<ListboxSelect>>", self._on_list_select)

        del_btn = tk.Button(list_frame, text="Delete Selected", bg="#633", fg="white",
                            activebackground="#844", relief="flat",
                            command=self._delete_selected)
        del_btn.pack(fill="x", pady=(4, 0))

        # ── Canvas ───────────────────────────────────────────────────────────
        canvas_frame = tk.Frame(main, bg="#1a1a1a")
        canvas_frame.pack(side="right", fill="both", expand=True)

        self.canvas = tk.Canvas(canvas_frame, bg="#1a1a1a",
                                highlightthickness=0)
        self.canvas.pack(fill="both", expand=True, padx=4, pady=4)

        # Canvas events
        self.canvas.bind("<ButtonPress-1>", self._on_left_down)
        self.canvas.bind("<B1-Motion>", self._on_left_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_left_up)
        self.canvas.bind("<ButtonPress-3>", self._on_right_down)
        self.canvas.bind("<B3-Motion>", self._on_right_drag)
        self.canvas.bind("<ButtonRelease-3>", self._on_right_up)
        self.canvas.bind("<MouseWheel>", self._on_scroll)
        self.canvas.bind("<Motion>", self._on_motion)
        self.canvas.bind("<Configure>", self._on_resize)

        self._set_tool("terrain_raise")

    # ── Tool selection ───────────────────────────────────────────────────────
    def _set_tool(self, tool: str):
        # Finish current road if switching away
        if self.tool == "road" and tool != "road" and self.current_road:
            if len(self.current_road) >= 2:
                self.roads.append(list(self.current_road))
            self.current_road.clear()

        self.tool = tool
        for tid, btn in self._tool_buttons.items():
            btn.configure(relief="sunken" if tid == tool else "flat",
                          bg="#566" if tid == tool else "#444")
        info = OBJECT_TYPES.get(tool, {}).get("label", tool.replace("_", " ").title())
        self._info_var.set(f"Tool: {info}")

    # ── Canvas coordinate helpers ────────────────────────────────────────────
    def _canvas_size(self) -> tuple[int, int]:
        return self.canvas.winfo_width(), self.canvas.winfo_height()

    def _px_per_cell(self) -> float:
        w, h = self._canvas_size()
        return min(w, h) / GRID

    def _canvas_offset(self) -> tuple[float, float]:
        w, h = self._canvas_size()
        s = min(w, h)
        return (w - s) / 2, (h - s) / 2

    def _grid_from_px(self, px: float, py: float) -> tuple[int, int]:
        ox, oy = self._canvas_offset()
        pp = self._px_per_cell()
        gx = int((px - ox) / pp)
        gz = int((py - oy) / pp)
        return max(0, min(GRID - 1, gx)), max(0, min(GRID - 1, gz))

    def _px_from_grid(self, gx: int, gz: int) -> tuple[float, float]:
        ox, oy = self._canvas_offset()
        pp = self._px_per_cell()
        return ox + gx * pp, oy + gz * pp

    def _px_from_world(self, wx: float, wz: float) -> tuple[float, float]:
        gx, gz = grid_from_world(wx, wz)
        return self._px_from_grid(gx, gz)

    def _world_from_px(self, px: float, py: float) -> tuple[float, float]:
        gx, gz = self._grid_from_px(px, py)
        return world_from_grid(gx, gz)

    # ── Terrain painting ─────────────────────────────────────────────────────
    def _paint_terrain(self, px: float, py: float, raise_: bool):
        gx, gz = self._grid_from_px(px, py)
        r = self.brush_radius
        strength = self.brush_strength * (1 if raise_ else -1)

        if self.tool == "terrain_smooth":
            self._smooth_at(gx, gz, r)
        else:
            for dz in range(-r, r + 1):
                for dx in range(-r, r + 1):
                    dist = math.sqrt(dx * dx + dz * dz)
                    if dist > r:
                        continue
                    nx, nz = gx + dx, gz + dz
                    if 0 <= nx < GRID and 0 <= nz < GRID:
                        falloff = 1.0 - dist / (r + 0.01)
                        self.heightmap[nz][nx] += strength * falloff

        self._redraw_terrain()

    def _smooth_at(self, gx: int, gz: int, r: int):
        for dz in range(-r, r + 1):
            for dx in range(-r, r + 1):
                dist = math.sqrt(dx * dx + dz * dz)
                if dist > r:
                    continue
                nx, nz = gx + dx, gz + dz
                if 1 <= nx < GRID - 1 and 1 <= nz < GRID - 1:
                    avg = (self.heightmap[nz - 1][nx] + self.heightmap[nz + 1][nx] +
                           self.heightmap[nz][nx - 1] + self.heightmap[nz][nx + 1]) / 4
                    falloff = 1.0 - dist / (r + 0.01)
                    self.heightmap[nz][nx] += (avg - self.heightmap[nz][nx]) * 0.3 * falloff

    def _save_terrain_snapshot(self):
        snapshot = [row[:] for row in self.heightmap]
        self.undo_stack.append(snapshot)
        if len(self.undo_stack) > 30:
            self.undo_stack.pop(0)

    def _undo_terrain(self):
        if not self.undo_stack:
            return
        self.heightmap = self.undo_stack.pop()
        self._redraw_terrain()
        self._info_var.set("Undo terrain")

    # ── Drawing ──────────────────────────────────────────────────────────────
    def _redraw_terrain(self):
        self.canvas.delete("terrain")
        pp = self._px_per_cell()
        ox, oy = self._canvas_offset()
        # Draw at reduced resolution for performance (every Nth cell)
        step = max(1, int(2 / pp)) if pp < 2 else 1
        block = pp * step

        for gz in range(0, GRID - 1, step):
            for gx in range(0, GRID - 1, step):
                h = self.heightmap[gz][gx]
                color = height_color(h)
                x1 = ox + gx * pp
                y1 = oy + gz * pp
                self.canvas.create_rectangle(
                    x1, y1, x1 + block, y1 + block,
                    fill=color, outline="", tags="terrain")

        # Water overlay at water level cells
        # (shown implicitly by blue colors)

        self._redraw_objects()
        self._redraw_roads()

    def _redraw_objects(self):
        self.canvas.delete("obj")
        pp = self._px_per_cell()
        sz = max(6, pp * 2.5)

        for i, obj in enumerate(self.objects):
            px, py_ = self._px_from_world(obj["wx"], obj["wz"])
            info = OBJECT_TYPES.get(obj["type"], {"color": "#fff", "shape": "circle"})
            color = info["color"]
            outline = "#fff" if i == self.selected_idx else ""
            width = 2 if i == self.selected_idx else 0
            shape = info["shape"]

            if shape == "circle":
                self.canvas.create_oval(
                    px - sz / 2, py_ - sz / 2, px + sz / 2, py_ + sz / 2,
                    fill=color, outline=outline, width=width, tags="obj")
            elif shape == "rect":
                self.canvas.create_rectangle(
                    px - sz / 2, py_ - sz / 2, px + sz / 2, py_ + sz / 2,
                    fill=color, outline=outline, width=width, tags="obj")
            elif shape == "diamond":
                pts = [px, py_ - sz / 2, px + sz / 2, py_,
                       px, py_ + sz / 2, px - sz / 2, py_]
                self.canvas.create_polygon(pts, fill=color, outline=outline,
                                           width=width, tags="obj")
            elif shape == "triangle":
                pts = [px, py_ - sz / 2, px + sz / 2, py_ + sz / 2,
                       px - sz / 2, py_ + sz / 2]
                self.canvas.create_polygon(pts, fill=color, outline=outline,
                                           width=width, tags="obj")
            elif shape == "star":
                # Simple 4-point star
                pts = [px, py_ - sz * 0.6,
                       px + sz * 0.15, py_ - sz * 0.15,
                       px + sz * 0.6, py_,
                       px + sz * 0.15, py_ + sz * 0.15,
                       px, py_ + sz * 0.6,
                       px - sz * 0.15, py_ + sz * 0.15,
                       px - sz * 0.6, py_,
                       px - sz * 0.15, py_ - sz * 0.15]
                self.canvas.create_polygon(pts, fill=color, outline=outline,
                                           width=width, tags="obj")

            # Label
            self.canvas.create_text(px, py_ + sz / 2 + 6,
                                    text=OBJECT_TYPES.get(obj["type"], {}).get("label", obj["type"]),
                                    fill="#ddd", font=("Segoe UI", 7), tags="obj")

    def _redraw_roads(self):
        self.canvas.delete("road")
        all_roads = list(self.roads)
        if self.current_road:
            all_roads.append(self.current_road)

        for road in all_roads:
            if len(road) < 2:
                continue
            points = []
            for wx, wz in road:
                px, py_ = self._px_from_world(wx, wz)
                points.extend([px, py_])
            self.canvas.create_line(*points, fill="#dda520", width=3,
                                    smooth=True, tags="road")

    # ── Mouse events ─────────────────────────────────────────────────────────
    def _on_left_down(self, event):
        if self.tool in ("terrain_raise", "terrain_lower", "terrain_smooth"):
            if not self._current_stroke_saved:
                self._save_terrain_snapshot()
                self._current_stroke_saved = True
            self._painting = True
            self._paint_terrain(event.x, event.y, self.tool != "terrain_lower")
        elif self.tool == "road":
            wx, wz = self._world_from_px(event.x, event.y)
            self.current_road.append((wx, wz))
            self._redraw_roads()
        elif self.tool in OBJECT_TYPES:
            self._place_object(event.x, event.y)
        else:
            self._select_at(event.x, event.y)

    def _on_left_drag(self, event):
        if self._painting:
            self._paint_terrain(event.x, event.y, self.tool != "terrain_lower")
        elif self.tool == "road":
            wx, wz = self._world_from_px(event.x, event.y)
            # Only add point if far enough from last
            if self.current_road:
                lx, lz = self.current_road[-1]
                if abs(wx - lx) + abs(wz - lz) > CELL_WORLD * 0.8:
                    self.current_road.append((wx, wz))
                    self._redraw_roads()
            else:
                self.current_road.append((wx, wz))

    def _on_left_up(self, event):
        self._painting = False
        self._current_stroke_saved = False

    def _on_right_down(self, event):
        if self.tool in ("terrain_raise", "terrain_lower", "terrain_smooth"):
            if not self._current_stroke_saved:
                self._save_terrain_snapshot()
                self._current_stroke_saved = True
            self._painting = True
            self._paint_terrain(event.x, event.y, False)
        elif self.tool == "road":
            # Finish current road
            if len(self.current_road) >= 2:
                self.roads.append(list(self.current_road))
            self.current_road.clear()
            self._redraw_roads()

    def _on_right_drag(self, event):
        if self._painting:
            self._paint_terrain(event.x, event.y, False)

    def _on_right_up(self, event):
        self._painting = False
        self._current_stroke_saved = False

    def _on_scroll(self, event):
        delta = 1 if event.delta > 0 else -1
        self.brush_radius = max(1, min(15, self.brush_radius + delta))
        self._radius_var.set(self.brush_radius)
        self._info_var.set(f"Brush radius: {self.brush_radius}")

    def _on_motion(self, event):
        wx, wz = self._world_from_px(event.x, event.y)
        gx, gz = self._grid_from_px(event.x, event.y)
        if 0 <= gx < GRID and 0 <= gz < GRID:
            h = self.heightmap[gz][gx]
            self._info_var.set(f"World: ({wx:.1f}, {wz:.1f})  Height: {h:.2f}")

    def _on_resize(self, event):
        self._redraw_terrain()

    # ── Object placement ─────────────────────────────────────────────────────
    def _place_object(self, px: float, py: float):
        wx, wz = self._world_from_px(px, py)
        otype = self.tool

        # Enforce unique objects (e.g., only one player spawn)
        info = OBJECT_TYPES.get(otype, {})
        if info.get("unique"):
            self.objects = [o for o in self.objects if o["type"] != otype]

        self.objects.append({"type": otype, "wx": round(wx, 2), "wz": round(wz, 2)})
        self._refresh_object_list()
        self._redraw_objects()

    def _select_at(self, px: float, py: float):
        pp = self._px_per_cell()
        sz = max(6, pp * 2.5)
        best_idx = None
        best_dist = float("inf")
        for i, obj in enumerate(self.objects):
            opx, opy = self._px_from_world(obj["wx"], obj["wz"])
            d = math.sqrt((px - opx) ** 2 + (py - opy) ** 2)
            if d < sz and d < best_dist:
                best_dist = d
                best_idx = i
        self.selected_idx = best_idx
        self._obj_listbox.selection_clear(0, tk.END)
        if best_idx is not None:
            self._obj_listbox.selection_set(best_idx)
        self._redraw_objects()

    def _on_list_select(self, event):
        sel = self._obj_listbox.curselection()
        self.selected_idx = sel[0] if sel else None
        self._redraw_objects()

    def _delete_selected(self):
        if self.selected_idx is not None and 0 <= self.selected_idx < len(self.objects):
            del self.objects[self.selected_idx]
            self.selected_idx = None
            self._refresh_object_list()
            self._redraw_objects()

    def _refresh_object_list(self):
        self._obj_listbox.delete(0, tk.END)
        for obj in self.objects:
            label = OBJECT_TYPES.get(obj["type"], {}).get("label", obj["type"])
            self._obj_listbox.insert(tk.END, f"{label}  ({obj['wx']:.0f}, {obj['wz']:.0f})")

    # ── Terrain generation ───────────────────────────────────────────────────
    def _generate_default_terrain(self):
        for gz in range(GRID):
            for gx in range(GRID):
                wx, wz = world_from_grid(gx, gz)
                self.heightmap[gz][gx] = hill_noise(wx, wz)

    def _generate_default_terrain_and_redraw(self):
        self._save_terrain_snapshot()
        self._generate_default_terrain()
        self._redraw_terrain()
        self._info_var.set("Generated default terrain")

    def _flatten_all(self):
        self._save_terrain_snapshot()
        for gz in range(GRID):
            for gx in range(GRID):
                self.heightmap[gz][gx] = 0.0
        self._redraw_terrain()
        self._info_var.set("Terrain flattened")

    # ── New level ────────────────────────────────────────────────────────────
    def _new_level(self):
        if messagebox.askyesno("New Level", "Discard current level?"):
            self.heightmap = [[0.0] * GRID for _ in range(GRID)]
            self.objects.clear()
            self.roads.clear()
            self.current_road.clear()
            self.undo_stack.clear()
            self.selected_idx = None
            self.file_path = None
            self._refresh_object_list()
            self._generate_default_terrain()
            self._redraw_terrain()

    # ── Save / Load ──────────────────────────────────────────────────────────
    def _get_save_data(self) -> dict:
        return {
            "version": 1,
            "groundSize": GROUND_SIZE,
            "subdivisions": SUBDIVISIONS,
            "waterY": WATER_Y,
            "heightmap": self.heightmap,
            "objects": self.objects,
            "roads": [[(p[0], p[1]) for p in road] for road in self.roads],
        }

    def _save(self):
        if not self.file_path:
            self._save_as()
            return
        self._write_file(self.file_path)

    def _save_as(self):
        default_dir = os.path.join(os.path.dirname(__file__), "..", "public")
        path = filedialog.asksaveasfilename(
            initialdir=default_dir,
            defaultextension=".json",
            filetypes=[("JSON Files", "*.json"), ("All Files", "*.*")],
            title="Save Level",
        )
        if path:
            self.file_path = path
            self._write_file(path)

    def _write_file(self, path: str):
        data = self._get_save_data()
        with open(path, "w") as f:
            json.dump(data, f)
        self._info_var.set(f"Saved: {os.path.basename(path)}")
        self.title(f"Level Builder — {os.path.basename(path)}")

    def _open_file(self):
        default_dir = os.path.join(os.path.dirname(__file__), "..", "public")
        path = filedialog.askopenfilename(
            initialdir=default_dir,
            defaultextension=".json",
            filetypes=[("JSON Files", "*.json"), ("All Files", "*.*")],
            title="Open Level",
        )
        if not path:
            return
        with open(path, "r") as f:
            data = json.load(f)

        # Basic validation
        if not isinstance(data, dict) or "heightmap" not in data:
            messagebox.showerror("Error", "Invalid level file.")
            return

        self.heightmap = data["heightmap"]
        self.objects = data.get("objects", [])
        self.roads = [[(p[0], p[1]) for p in road] for road in data.get("roads", [])]
        self.current_road.clear()
        self.undo_stack.clear()
        self.selected_idx = None
        self.file_path = path
        self._refresh_object_list()
        self._redraw_terrain()
        self.title(f"Level Builder — {os.path.basename(path)}")
        self._info_var.set(f"Opened: {os.path.basename(path)}")


if __name__ == "__main__":
    app = LevelBuilder()
    app.geometry("1100x720")
    app.mainloop()
