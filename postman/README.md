# Local printer status simulation

Requires the Postman CLI and the project's existing npm dependencies. No real printer, camera connection, account credentials, or shared Postman workspace is needed.

Start the simulation in one terminal:

```bash
postman simulation run postman/simulations/printer-status.sim.yaml --port 4901
```

In another terminal:

```bash
npm run test:printer-status
```

The tests send real HTTP requests to `http://127.0.0.1:4901/printer/api/v1/status`. Override the base address with `PRINTER_STATUS_SIMULATION_URL` if needed. Stop the simulation after testing.

The response shape follows the existing `api-responses/status-response when printing.json` fixture and the application's `printer.state` contract. The mock accepts only GET `/api/v1/status` with the dummy header `X-Api-Key: test-printer-key`. Other routes return 501, and invalid credentials return 401. Query parameters `case` and `run` select an isolated test sequence; these selectors are simulation controls, not PrusaLink API features.

Scenarios cover completion, cancellation, errors, paused printing, temporary HTTP failure, missing state, initial IDLE, immediate capture, and a wait timeout. The `cli-finished` sequence supports a manual end-to-end CLI check using a local video fixture. The simulation models lifecycle behavior only; it does not model video, job metadata, or camera faults. The CLI was signed out during development, so no owner-published mock was retrieved and no shared resources were created.
