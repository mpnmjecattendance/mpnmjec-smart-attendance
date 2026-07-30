"""Install the face-recognition runtime without requiring a Windows C++ compiler.

InsightFace 0.7.3 publishes a source distribution.  Its optional 3D-mesh
extension is unrelated to FaceAnalysis, but it makes a normal Windows install
require Microsoft C++ Build Tools.  The fallback below builds the same package
without that optional extension, so enrollment and kiosk recognition run on
standard Windows kiosk machines.
"""

from __future__ import annotations

import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from urllib.request import urlretrieve


INSIGHTFACE_VERSION = "0.7.3"
INSIGHTFACE_SOURCE_URL = (
    "https://files.pythonhosted.org/packages/0b/8d/"
    "0f4af90999ca96cf8cb846eb5ae27c5ef5b390f9c090dd19e4fa76364c13/"
    "insightface-0.7.3.tar.gz"
)
VISION_RUNTIME_REQUIREMENTS = [
    "numpy>=1.26,<2",
    "opencv-python-headless>=4.9,<4.12",
    "onnxruntime>=1.18,<2",
    "onnx>=1.16,<2",
    "requests>=2.31,<3",
    "tqdm>=4.66,<5",
    "scipy>=1.10,<2",
    "scikit-learn>=1.3,<2",
    "scikit-image>=0.21,<1",
    "Pillow>=10,<12",
    "matplotlib>=3.7,<4",
    "easydict>=1.13,<2",
    "albumentations>=1.4,<2",
    "prettytable>=3.10,<4",
]


def run_pip(*args: str) -> None:
    subprocess.run([sys.executable, "-m", "pip", "install", *args], check=True)


def vision_imports_work() -> bool:
    try:
        from insightface.app import FaceAnalysis  # noqa: F401
    except (ImportError, OSError):
        return False
    return True


def install_windows_insightface_fallback() -> None:
    """Install InsightFace without its optional compiled 3D-mesh extension."""
    run_pip("Cython>=0.29.36,<3.1")

    with tempfile.TemporaryDirectory(prefix="attendance-insightface-") as temporary_directory:
        temp_path = Path(temporary_directory)
        archive_path = temp_path / f"insightface-{INSIGHTFACE_VERSION}.tar.gz"
        urlretrieve(INSIGHTFACE_SOURCE_URL, archive_path)

        with tarfile.open(archive_path, "r:gz") as archive:
            for member in archive.getmembers():
                member_path = (temp_path / member.name).resolve()
                if not member_path.is_relative_to(temp_path.resolve()):
                    raise RuntimeError("Unsafe path in the InsightFace source archive.")
            archive.extractall(temp_path)

        source_path = temp_path / f"insightface-{INSIGHTFACE_VERSION}"
        setup_path = source_path / "setup.py"
        setup_contents = setup_path.read_text(encoding="utf-8")
        source_line = "ext_modules=cythonize(extensions)"
        if source_line not in setup_contents:
            raise RuntimeError("Unexpected InsightFace source layout; optional extension could not be disabled.")

        setup_path.write_text(setup_contents.replace(source_line, "ext_modules=[]"), encoding="utf-8")

        # ``insightface.app`` imports the optional mask renderer by default.
        # That renderer imports the disabled 3D-mesh extension, even though
        # FaceAnalysis itself does not use it.
        app_init_path = source_path / "insightface" / "app" / "__init__.py"
        app_init_path.write_text("from .face_analysis import FaceAnalysis\n", encoding="utf-8")
        run_pip("--no-build-isolation", "--no-deps", str(source_path))


def main() -> None:
    run_pip(*VISION_RUNTIME_REQUIREMENTS)
    if vision_imports_work():
        print("Face-recognition runtime is ready.")
        return

    if sys.platform == "win32":
        install_windows_insightface_fallback()
    else:
        run_pip(f"insightface=={INSIGHTFACE_VERSION}")

    if not vision_imports_work():
        raise RuntimeError("InsightFace installed, but the face-recognition runtime could not be imported.")

    print("Face-recognition runtime is ready.")


if __name__ == "__main__":
    main()
