#!/usr/bin/env python3
"""Small manufactured-solution convergence check for the fenicsx-beat solver."""
from __future__ import annotations

import numpy as np
from mpi4py import MPI
import dolfinx
import ufl
import beat


def v_exact(x, t):
    phi = ufl.cos(2 * ufl.pi * x[0]) * ufl.cos(2 * ufl.pi * x[1])
    return phi * ufl.sin(t) * ufl.exp(t)


def s_exact(x, t):
    phi = ufl.cos(2 * ufl.pi * x[0]) * ufl.cos(2 * ufl.pi * x[1])
    return 0.5 * phi * ufl.exp(t) * (ufl.sin(t) - ufl.cos(t))


def stimulus(x, t):
    phi = ufl.cos(2 * ufl.pi * x[0]) * ufl.cos(2 * ufl.pi * x[1])
    return phi * ufl.exp(t) * ((2.0 + 8.0 * ufl.pi**2) * ufl.sin(t) + ufl.cos(t))


def exact_ode(states, t, dt, parameters):
    v, s = states
    result = np.zeros_like(states)
    result[0] = v * np.exp(-dt)
    result[1] = s + v * (1.0 - np.exp(-dt))
    return result


def main() -> None:
    comm = MPI.COMM_WORLD
    mesh = dolfinx.mesh.create_unit_square(comm, 12, 12, dolfinx.mesh.CellType.triangle)
    V = beat.utils.space_from_string("CG_2", mesh, dim=1)
    errors = []
    dts = [0.5, 0.25, 0.125, 0.0625]
    print("dt         L2 error       observed rate")

    for dt in dts:
        time = dolfinx.fem.Constant(mesh, dolfinx.default_scalar_type(0.0))
        x = ufl.SpatialCoordinate(mesh)
        pde = beat.MonodomainModel(
            time=time,
            mesh=mesh,
            M=1.0,
            I_s=stimulus(x, time),
            params={"theta": 0.5, "degree": 2},
        )
        s = dolfinx.fem.Function(V)
        v = dolfinx.fem.Function(V)
        points = beat.utils.interpolation_points(V)
        s.interpolate(dolfinx.fem.Expression(s_exact(x, time), points))
        v.interpolate(dolfinx.fem.Expression(v_exact(x, time), points))
        states = np.stack((v.x.array.copy(), s.x.array.copy()))
        ode = beat.odesolver.DolfinODESolver(
            v_ode=v,
            v_pde=pde.state,
            fun=exact_ode,
            init_states=states,
            parameters=np.array([]),
            num_states=2,
            v_index=0,
        )
        solver = beat.MonodomainSplittingSolver(pde=pde, ode=ode, theta=0.5)
        solver.solve((0.0, 1.0), dt=dt)
        time.value = 1.0
        error_form = dolfinx.fem.form((pde.state - v_exact(x, time)) ** 2 * ufl.dx)
        error = np.sqrt(comm.allreduce(dolfinx.fem.assemble_scalar(error_form), MPI.SUM))
        rate = "—" if not errors else f"{np.log(errors[-1] / error) / np.log(2):.3f}"
        print(f"{dt:<10.5f} {error:<14.6e} {rate}")
        errors.append(error)

    rates = np.log(np.asarray(errors[:-1]) / errors[1:]) / np.log(2)
    if not np.all(rates > 1.2):
        raise SystemExit(f"Temporal convergence was below expected range: {rates}")
    print("PASS: manufactured solution shows near second-order temporal convergence.")
    print("This checks solver numerics for this manufactured case only; it does not validate anatomy or ECG accuracy.")


if __name__ == "__main__":
    main()
