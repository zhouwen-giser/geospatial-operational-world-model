# Third-party notices

The project-owned CRS Normalization Service source is licensed under MIT.
Runtime functionality is provided by the following separately licensed
components and their transitive dependencies:

| Component | Version baseline | License | Role |
| --- | ---: | --- | --- |
| gdal-async | 3.12.3 | MIT | Node.js GDAL/PROJ integration |
| GDAL | gdal-async bundled baseline | MIT-style | Coordinate-system and data abstraction runtime |
| PROJ | gdal-async bundled baseline | MIT | Coordinate transformation engine and `proj.db` |

The container build installs these components from the committed npm lockfile.
Their complete license texts remain available in the installed packages and
must be preserved in redistributed container images.
