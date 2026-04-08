"""
sinusoidal_media variant

Exposes cells to a sinusoidal mixture of two named media:

    p(t) = (sin(2*pi/T * t) + 1) / 2    -- fraction of MEDIA_B
    r(t) = 1 - p(t)                      -- fraction of MEDIA_A

The variant index encodes the period T in minutes (index=2 → T=2 min).
The two media are specified via environment variables (see below).

Environment variables (all optional, with defaults):
    SINE_MEDIA_A      base media              (default: minimal  = MIX0-57,         GLC 11.101 mM)
    SINE_MEDIA_B      glucose-supplemented    (default: minimal_GLC_2mM = MIX0-57-GLC-2mM, GLC 2 mM)

Usage (manual):
    python runscripts/manual/runSim.py --generations 4 \\
        --variant sinusoidal_media 2 2 sim_name

    # With custom media:
    SINE_MEDIA_A=MIX0-57 SINE_MEDIA_B=MIX0-57-GLC-5mM \\
        python runscripts/manual/runSim.py --generations 4 \\
        --variant sinusoidal_media 2 2 sim_name

Usage (Docker):
    docker/local/run.sh sim --generations 4 \\
        --variant sinusoidal_media 2 2 sim_name

    # With custom media:
    SINE_MEDIA_A=MIX0-57 SINE_MEDIA_B=MIX0-57-GLC-5mM \\
        docker/local/run.sh sim --generations 4 \\
        --variant sinusoidal_media 2 2 sim_name

Modifies:
    sim_data.external_state.sinusoidal_media_config
    sim_data.external_state.current_timeline_id
"""

import os

# Media are referenced by their recipe name (media_recipes.tsv), not by file name:
#   MIX0-57         -> recipe "minimal"         (GLC = 11.101 mM)
#   MIX0-57-GLC-2mM -> recipe "minimal_GLC_2mM" (GLC = 2.0 mM)
DEFAULT_MEDIA_A = 'minimal'
DEFAULT_MEDIA_B = 'minimal_GLC_2mM'


def sinusoidal_media(sim_data, index):
	period_seconds = float(index) * 60.0  # index = period in minutes

	media_a = os.environ.get('SINE_MEDIA_A', DEFAULT_MEDIA_A)
	media_b = os.environ.get('SINE_MEDIA_B', DEFAULT_MEDIA_B)

	# Validate that both media exist in saved_media
	saved = sim_data.external_state.saved_media
	for name in (media_a, media_b):
		if name not in saved:
			raise ValueError(
				'sinusoidal_media: media "{}" not found in saved_media. '
				'Available: {}'.format(name, sorted(saved))
			)

	# Store mixing parameters for LocalEnvironment.update()
	sim_data.external_state.sinusoidal_media_config = {
		'media_a': media_a,
		'media_b': media_b,
		'period': period_seconds,
		'start_time': 0.0,
	}

	# Register a one-event timeline so LocalEnvironment initializes its
	# molecule-ID list from media_b (use the union of both media's molecules).
	sim_data.external_state.saved_timelines['_sinusoidal_init'] = [
		(0.0, media_b)
	]
	sim_data.external_state.current_timeline_id = '_sinusoidal_init'

	# Find a matching initial condition; fall back to the default if none found
	conditions = [
		cond for cond in sim_data.condition_active_tfs
		if sim_data.conditions[cond]['nutrients'] == media_b
	]
	if len(conditions) == 1:
		sim_data.condition = conditions[0]
	else:
		print(
			'Warning: no condition found for {} nutrients. '
			'Using default condition ({}).'.format(media_b, sim_data.condition)
		)

	return dict(
		shortName='sinusoidal_T{}min'.format(index),
		desc=(
			'Sinusoidal media: period {}min, '
			'{} <-> {}'.format(index, media_a, media_b)
		),
	), sim_data
