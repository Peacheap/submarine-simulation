#!/usr/bin/env python3
"""Generate a hierarchical verification submarine glTF for CIMPro TwinMaster import.

Node names match equipment-map.json / Vue twin target IDs.
Import into CIMPro with merge mode = 不合并 to keep hierarchy.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

OUT = Path(__file__).with_name("sim_submarine_verify.gltf")
BIN = Path(__file__).with_name("sim_submarine_verify.bin")

# name, parent, center(xyz), size(xyz), rgba
# Y-up, submarine length along +Z (bow +Z)
PARTS = [
    ("SimVerifyRoot", None, (0, 0, 0), (0.01, 0.01, 0.01), (1, 1, 1, 0)),
    ("Sub_Hull", "SimVerifyRoot", (0, 0, 0), (2.2, 2.0, 14.0), (0.25, 0.32, 0.40, 1)),
    ("Sub_Sail", "Sub_Hull", (0, 1.6, -1.5), (0.7, 1.4, 2.2), (0.30, 0.36, 0.44, 1)),
    ("Eq_229_Qianfu", "Sub_Hull", (0, 0.2, 4.5), (1.0, 0.8, 1.6), (0.20, 0.55, 0.85, 1)),
    ("Eq_149_Caoduo", "Sub_Hull", (0, -0.2, -6.2), (1.6, 0.5, 1.0), (0.35, 0.70, 0.45, 1)),
    ("Eq_150_Junheng", "Sub_Hull", (0, -0.6, 1.0), (1.4, 0.5, 2.0), (0.55, 0.55, 0.25, 1)),
    ("Eq_151_Reactor", "Sub_Hull", (0, 0.0, -0.5), (1.2, 1.2, 2.0), (0.85, 0.45, 0.20, 1)),
    ("Eq_152_Cooling", "Sub_Hull", (0, -0.9, -0.5), (1.5, 0.4, 2.2), (0.25, 0.65, 0.70, 1)),
    ("Eq_153_Aux", "Sub_Hull", (0.9, 0.0, 1.5), (0.6, 0.8, 1.4), (0.65, 0.40, 0.75, 1)),
    ("Eq_228_Propulsion", "Sub_Hull", (0, 0.0, -7.2), (1.0, 1.0, 1.2), (0.85, 0.30, 0.30, 1)),
    ("Cam_Overview_Marker", "SimVerifyRoot", (0, 8, -18), (0.4, 0.4, 0.4), (0.9, 0.9, 0.2, 0.6)),
    ("Cam_Side_Marker", "SimVerifyRoot", (12, 2, 0), (0.4, 0.4, 0.4), (0.9, 0.9, 0.2, 0.6)),
    ("Cam_Detail_Marker", "SimVerifyRoot", (3, 1, -7), (0.3, 0.3, 0.3), (0.9, 0.9, 0.2, 0.6)),
    ("Cam_FaultFocus_Marker", "SimVerifyRoot", (2, 2, 0), (0.3, 0.3, 0.3), (1.0, 0.4, 0.1, 0.6)),
    ("WP_1", "SimVerifyRoot", (0, 0, 20), (0.5, 0.5, 0.5), (0.3, 0.9, 0.5, 0.7)),
    ("WP_2", "SimVerifyRoot", (15, 0, 40), (0.5, 0.5, 0.5), (0.3, 0.9, 0.5, 0.7)),
    ("WP_3", "SimVerifyRoot", (30, 0, 55), (0.5, 0.5, 0.5), (0.3, 0.9, 0.5, 0.7)),
    ("Phase_Banner_552", "SimVerifyRoot", (0, 5, 0), (3.0, 0.3, 0.3), (0.2, 0.7, 1.0, 0.85)),
    ("Phase_Banner_553", "SimVerifyRoot", (0, 5.5, 0), (3.0, 0.3, 0.3), (1.0, 0.45, 0.2, 0.85)),
    ("Phase_Banner_554", "SimVerifyRoot", (0, 6, 0), (3.0, 0.3, 0.3), (0.4, 0.85, 0.4, 0.85)),
]


def box_mesh(sx: float, sy: float, sz: float):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    # 8 corners
    corners = np.array(
        [
            [-hx, -hy, -hz],
            [hx, -hy, -hz],
            [hx, hy, -hz],
            [-hx, hy, -hz],
            [-hx, -hy, hz],
            [hx, -hy, hz],
            [hx, hy, hz],
            [-hx, hy, hz],
        ],
        dtype=np.float32,
    )
    faces = [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ]
    positions = []
    normals = []
    indices = []
    for face in faces:
        a, b, c, d = (corners[i] for i in face)
        n = np.cross(b - a, c - a)
        n = n / (np.linalg.norm(n) + 1e-8)
        base = len(positions)
        for p in (a, b, c, d):
            positions.append(p)
            normals.append(n)
        indices.extend([base, base + 1, base + 2, base, base + 2, base + 3])
    return (
        np.asarray(positions, dtype=np.float32),
        np.asarray(normals, dtype=np.float32),
        np.asarray(indices, dtype=np.uint16),
    )


def main():
    blob = bytearray()
    accessors = []
    buffer_views = []
    meshes = []
    materials = []
    nodes = []
    name_to_index = {}

    def align4(buf: bytearray):
        while len(buf) % 4:
            buf.append(0)

    def add_accessor(data: np.ndarray, component_type: int, typ: str, target: int):
        align4(blob)
        byte_offset = len(blob)
        raw = data.tobytes()
        blob.extend(raw)
        buffer_views.append(
            {
                "buffer": 0,
                "byteOffset": byte_offset,
                "byteLength": len(raw),
                "target": target,
            }
        )
        acc = {
            "bufferView": len(buffer_views) - 1,
            "componentType": component_type,
            "count": int(data.shape[0]),
            "type": typ,
        }
        if typ == "VEC3":
            acc["max"] = data.max(axis=0).tolist()
            acc["min"] = data.min(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    # Invisible root marker mesh skipped when size tiny + alpha 0 — still create mesh for hull parts
    for name, parent, center, size, rgba in PARTS:
        name_to_index[name] = len(nodes)
        mat_index = len(materials)
        materials.append(
            {
                "name": f"Mat_{name}",
                "pbrMetallicRoughness": {
                    "baseColorFactor": list(rgba),
                    "metallicFactor": 0.2,
                    "roughnessFactor": 0.7,
                },
                "alphaMode": "BLEND" if rgba[3] < 0.999 else "OPAQUE",
                "doubleSided": True,
            }
        )

        mesh_index = None
        if size[0] > 0.05:
            pos, norm, idx = box_mesh(*size)
            pi = add_accessor(pos, 5126, "VEC3", 34962)
            ni = add_accessor(norm, 5126, "VEC3", 34962)
            ii = add_accessor(idx, 5123, "SCALAR", 34963)
            mesh_index = len(meshes)
            meshes.append(
                {
                    "name": f"Mesh_{name}",
                    "primitives": [
                        {
                            "attributes": {"POSITION": pi, "NORMAL": ni},
                            "indices": ii,
                            "material": mat_index,
                        }
                    ],
                }
            )

        node = {
            "name": name,
            "translation": list(center),
        }
        if mesh_index is not None:
            node["mesh"] = mesh_index
        nodes.append(node)

    # wire children
    children_map: dict[str, list[int]] = {}
    for name, parent, *_ in PARTS:
        if parent:
            children_map.setdefault(parent, []).append(name_to_index[name])
    for parent, kids in children_map.items():
        nodes[name_to_index[parent]]["children"] = kids

    scene_root = name_to_index["SimVerifyRoot"]
    gltf = {
        "asset": {
            "version": "2.0",
            "generator": "SCCODE sim_submarine_verify",
            "copyright": "verification asset for CIMPro + underwater-mock",
        },
        "scene": 0,
        "scenes": [{"name": "SimVerifyScene", "nodes": [scene_root]}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"uri": BIN.name, "byteLength": len(blob)}],
        "extras": {
            "purpose": "CIMPro twin development-flow verification",
            "importHint": "合并方式选择「不合并」以保留节点层级与名称",
            "equipmentNodes": [
                "Eq_229_Qianfu",
                "Eq_149_Caoduo",
                "Eq_150_Junheng",
                "Eq_151_Reactor",
                "Eq_152_Cooling",
                "Eq_153_Aux",
                "Eq_228_Propulsion",
            ],
        },
    }

    BIN.write_bytes(blob)
    OUT.write_text(json.dumps(gltf, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")
    print(f"Wrote {BIN} ({len(blob)} bytes)")
    print(f"Nodes: {len(nodes)}, meshes: {len(meshes)}")


if __name__ == "__main__":
    main()
