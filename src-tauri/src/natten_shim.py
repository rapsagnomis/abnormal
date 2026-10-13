"""Pure-PyTorch stand-in for the four NATTEN functions All-In-One uses, so the structure model
runs on the Apple GPU (NATTEN only has CPU kernels on macOS, and newer releases don't build or
import there). Same maths as NATTEN 0.15: each query attends to `kernel_size` neighbours spaced
`dilation` apart, the window shifted inwards at the edges, plus a relative position bias.
Checked against NATTEN 0.15.1 to float precision.
"""

import torch


def _window(length, kernel_size, dilation, device):
    """For each position: indices of its neighbours and of their relative-position bias,
    both (length, kernel_size). Ported from NATTEN's get_window_start / get_pb_start."""
    n = kernel_size // 2
    i = torch.arange(length, device=device)
    if dilation <= 1:
        start = torch.clamp(i - n, min=0) + (i + n >= length) * (length - i - n - 1)
        pb = n + (i < n) * (n - i) + (i + n >= length) * (length - i - 1 - n)
    else:
        imodd = i % dilation
        a = (length // dilation) * dilation
        b = length - a
        end_start = torch.where(imodd < b, length - b + imodd - 2 * n * dilation, a + imodd - kernel_size * dilation)
        start = torch.where(i - n * dilation < 0, imodd, torch.where(i + n * dilation >= length, end_start, i - n * dilation))
        pb = torch.where(
            i - n * dilation < 0,
            kernel_size - 1 - torch.div(i, dilation, rounding_mode="floor"),
            torch.where(i + n * dilation >= length, torch.div(length - i - 1, dilation, rounding_mode="floor"), torch.full_like(i, n)),
        )
    k = torch.arange(kernel_size, device=device)
    return start[:, None] + k[None, :] * dilation, pb[:, None] + k[None, :]


def natten1dqkrpb(query, key, rpb, kernel_size, dilation):
    """query, key: (B, H, L, D); rpb: (H, 2K-1) -> attention logits (B, H, L, K)."""
    idx, pb = _window(query.shape[2], kernel_size, dilation, query.device)
    neighbours = key[:, :, idx]  # (B, H, L, K, D)
    attn = (query.unsqueeze(3) * neighbours).sum(-1)
    if rpb is not None:
        attn = attn + rpb[:, pb].unsqueeze(0)
    return attn


def natten1dav(attn, value, kernel_size, dilation):
    """attn: (B, H, L, K); value: (B, H, L, D) -> (B, H, L, D)."""
    idx, _ = _window(value.shape[2], kernel_size, dilation, value.device)
    return (attn.unsqueeze(-1) * value[:, :, idx]).sum(3)


def natten2dqkrpb(query, key, rpb, kernel_size, dilation):
    """query, key: (B, H, X, Y, D); rpb: (H, 2K-1, 2K-1) -> (B, H, X, Y, K*K)."""
    _, _, x, y, _ = query.shape
    ix, px = _window(x, kernel_size, dilation, query.device)
    iy, py = _window(y, kernel_size, dilation, query.device)
    neighbours = key[:, :, ix[:, None, :, None], iy[None, :, None, :]]  # (B, H, X, Y, K, K, D)
    attn = (query[:, :, :, :, None, None, :] * neighbours).sum(-1)
    if rpb is not None:
        attn = attn + rpb[:, px[:, None, :, None], py[None, :, None, :]].unsqueeze(0)
    return attn.flatten(-2)


def natten2dav(attn, value, kernel_size, dilation):
    """attn: (B, H, X, Y, K*K); value: (B, H, X, Y, D) -> (B, H, X, Y, D)."""
    _, _, x, y, _ = value.shape
    ix, _ = _window(x, kernel_size, dilation, value.device)
    iy, _ = _window(y, kernel_size, dilation, value.device)
    neighbours = value[:, :, ix[:, None, :, None], iy[None, :, None, :]]  # (B, H, X, Y, K, K, D)
    attn = attn.unflatten(-1, (kernel_size, kernel_size))
    return (attn.unsqueeze(-1) * neighbours).sum((4, 5))
