"""Song structure for (a/b)normal, with All-In-One (allin1): beats, downbeats, tempo and labelled
sections (intro, verse, chorus, bridge, inst, solo, break, outro).

Two stages, run as separate processes so the app can overlap them across tracks (stem
separation uses the GPU, the structure model the CPU):

    runner.py demix AUDIO WORK_DIR
        Separate AUDIO into bass / drums / other / vocals with Demucs (htdemucs, what allin1 was
        trained on), on the Apple GPU when there is one, into WORK_DIR.
    runner.py structure AUDIO OUT_JSON WORK_DIR [--model harmonix-all]
        Spectrograms of those stems, then the model (8-fold ensemble by default), on CPU.
        Writes the result to OUT_JSON and deletes WORK_DIR.

NATTEN (neighbourhood attention, which allin1 imports) is replaced by `natten_shim.py` next
to this file: plain PyTorch, so nothing has to be compiled, and on CPU it is >10x faster than
NATTEN's own CPU kernels (~2 s per model for a 3-minute song; on MPS it is slower).

Each stage prints {"stage": ..., "seconds": ...} when done.
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

# Overlap between Demucs' analysis windows. Its default, 0.25, was ~15 % slower for no change
# in the resulting structure.
DEMUCS_OVERLAP = "0.1"


def install_natten_shim():
    import importlib.util
    import types

    spec = importlib.util.spec_from_file_location("natten.functional", Path(__file__).with_name("natten_shim.py"))
    functional = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(functional)
    natten = types.ModuleType("natten")
    natten.functional = functional
    sys.modules["natten"] = natten
    sys.modules["natten.functional"] = functional


def report(stage, started):
    print(json.dumps({"stage": stage, "seconds": round(time.time() - started, 2)}), flush=True)


def stems_dir(work, audio):
    # Where Demucs puts the stems, and where allin1 expects them.
    return work / "demix" / "htdemucs" / audio.stem


def demix(audio, work):
    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    started = time.time()
    subprocess.run(
        [
            sys.executable, "-m", "demucs.separate",
            "--out", str(work / "demix"),
            "--name", "htdemucs",
            "--device", device,
            "--overlap", DEMUCS_OVERLAP,
            str(audio),
        ],
        check=True,
    )
    report("demix", started)


def structure(audio, out_path, work, model_name):
    install_natten_shim()
    import torch
    from allin1.helpers import run_inference
    from allin1.models import load_pretrained_model
    from allin1.spectrogram import extract_spectrograms

    try:
        started = time.time()
        spec_paths = extract_spectrograms([stems_dir(work, audio)], work / "spec", multiprocess=False)
        report("spectrogram", started)

        started = time.time()
        model = load_pretrained_model(model_name=model_name, device="cpu")
        with torch.no_grad():
            result = run_inference(
                path=audio,
                spec_path=spec_paths[0],
                model=model,
                device="cpu",
                include_activations=False,
                include_embeddings=False,
            )
        report("structure", started)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    out = {
        "bpm": float(result.bpm) if result.bpm is not None else None,
        "beats": [float(b) for b in result.beats],
        "downbeats": [float(b) for b in result.downbeats],
        "beatPositions": [int(p) for p in result.beat_positions],
        "segments": [{"start": float(s.start), "end": float(s.end), "label": s.label} for s in result.segments],
    }
    Path(out_path).write_text(json.dumps(out))


def main():
    parser = argparse.ArgumentParser()
    stages = parser.add_subparsers(dest="stage", required=True)
    d = stages.add_parser("demix")
    d.add_argument("audio")
    d.add_argument("work")
    s = stages.add_parser("structure")
    s.add_argument("audio")
    s.add_argument("out")
    s.add_argument("work")
    s.add_argument("--model", default="harmonix-all")
    args = parser.parse_args()

    audio = Path(args.audio).resolve()
    if args.stage == "demix":
        demix(audio, Path(args.work))
    else:
        structure(audio, args.out, Path(args.work), args.model)


if __name__ == "__main__":
    sys.exit(main())
